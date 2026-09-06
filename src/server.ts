import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const ticketFile = path.join(rootDir, "data", "tickets.json");
const uploadDir = path.join(rootDir, "data", "uploads");
const publicDir = path.join(rootDir, "public");
const port = Number(process.env.PORT ?? 3000);

type Category = "Plumbing" | "Heating" | "Doors & locks" | "Electrical" | "Appliances" | "General maintenance";

type Ticket = {
  id: string;
  createdAt: string;
  location: string;
  residentName: string;
  imageUrl: string;
  description: string;
  category: Category;
  diagnosis: string;
  urgency: "Low" | "Medium" | "High";
  vendor: { name: string; specialty: string; initials: string };
};

const vendors: Record<Category, Ticket["vendor"]> = {
  Plumbing: { name: "ClearFlow Plumbing", specialty: "Plumbing specialist", initials: "CP" },
  Heating: { name: "Northline Heating", specialty: "Heating & HVAC", initials: "NH" },
  "Doors & locks": { name: "Secure Entry Co.", specialty: "Doors & locksmith", initials: "SE" },
  Electrical: { name: "BrightWire Electric", specialty: "Licensed electrician", initials: "BE" },
  Appliances: { name: "HomeTech Appliance", specialty: "Appliance repair", initials: "HT" },
  "General maintenance": { name: "FixRight Property Care", specialty: "General maintenance", initials: "FR" }
};

const categories = Object.keys(vendors) as Category[];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, file.mimetype.startsWith("image/"))
});

async function readTickets(): Promise<Ticket[]> {
  try {
    return JSON.parse(await fs.readFile(ticketFile, "utf8")) as Ticket[];
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function saveTickets(tickets: Ticket[]) {
  await fs.mkdir(path.dirname(ticketFile), { recursive: true });
  await fs.writeFile(ticketFile, JSON.stringify(tickets, null, 2));
}

function fallbackDiagnosis(description: string) {
  const value = description.toLowerCase();
  if (/leak|water|pipe|drip|faucet|toilet|sink/.test(value)) return { category: "Plumbing" as Category, diagnosis: "Possible water or plumbing issue", urgency: "High" as const };
  if (/heat|heater|radiator|boiler|cold/.test(value)) return { category: "Heating" as Category, diagnosis: "Heating system needs attention", urgency: "Medium" as const };
  if (/door|lock|key|hinge/.test(value)) return { category: "Doors & locks" as Category, diagnosis: "Door or lock repair needed", urgency: "Medium" as const };
  if (/electric|light|outlet|socket|wire/.test(value)) return { category: "Electrical" as Category, diagnosis: "Electrical issue needs inspection", urgency: "High" as const };
  if (/fridge|oven|washer|dryer|dishwasher|appliance/.test(value)) return { category: "Appliances" as Category, diagnosis: "Appliance service may be required", urgency: "Medium" as const };
  return { category: "General maintenance" as Category, diagnosis: "Maintenance inspection requested", urgency: "Low" as const };
}

function cleanModelJson(content: string) {
  const match = content.match(/\{[\s\S]*\}/);
  return JSON.parse(match?.[0] ?? content) as { category?: string; diagnosis?: string; urgency?: string };
}

async function normalizeIssuePhoto(rawImage: Buffer) {
  try {
    // Ollama is most reliable with conventional, reasonably sized image data. This
    // also corrects phone-camera orientation before the model sees the photo.
    return await sharp(rawImage, { failOn: "none" })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new Error("We couldn't read this image. Please try a JPEG, PNG, or WEBP photo.");
  }
}

async function analyzeIssue(imageBase64: string, description: string) {
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.OLLAMA_API_KEY) headers.Authorization = `Bearer ${process.env.OLLAMA_API_KEY}`;
  const prompt = `You are a property-maintenance triage assistant. Inspect the issue photo and resident note. Reply with JSON only: {"category":"one of ${categories.join(", ")}","diagnosis":"brief plain English assessment","urgency":"Low, Medium, or High"}. Use High for water leaks, exposed wires, gas/safety risks, or no heat in cold weather. Resident note: ${description || "No note provided."}`;
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL ?? "llama3.2-vision",
      stream: false,
      format: "json",
      messages: [{ role: "user", content: prompt, images: [imageBase64.replace(/^data:[^;]+;base64,/, "")] }]
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 240);
    throw new Error(`Ollama returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const body = await response.json() as { message?: { content?: string } };
  const result = cleanModelJson(body.message?.content ?? "{}");
  const category = categories.includes(result.category as Category) ? result.category as Category : fallbackDiagnosis(description).category;
  const urgency = ["Low", "Medium", "High"].includes(result.urgency ?? "") ? result.urgency as Ticket["urgency"] : fallbackDiagnosis(description).urgency;
  return { category, diagnosis: result.diagnosis?.slice(0, 160) || fallbackDiagnosis(description).diagnosis, urgency };
}

const app = express();
app.use(express.json());
app.use(express.static(publicDir));
app.use("/uploads", express.static(uploadDir));

app.get("/api/tickets", async (_req, res, next) => {
  try { res.json(await readTickets()); } catch (error) { next(error); }
});

app.post("/api/tickets", upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Please upload an image of the issue." });
    const description = (req.body.description ?? "").trim();
    const location = (req.body.location ?? "").trim();
    const residentName = (req.body.residentName ?? "").trim();
    if (!location || !residentName) return res.status(400).json({ error: "Location and resident name are required." });
    let normalizedPhoto: Buffer;
    try {
      normalizedPhoto = await normalizeIssuePhoto(req.file.buffer);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
    const id = `PS-${crypto.randomInt(1000, 10000)}`;
    const imageFilename = `${id}-${crypto.randomUUID()}.jpg`;
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(path.join(uploadDir, imageFilename), normalizedPhoto);
    let analysis;
    let analysisSource: "ollama" | "fallback" = "ollama";
    try {
      analysis = await analyzeIssue(normalizedPhoto.toString("base64"), description);
    } catch (error) {
      console.warn("Ollama analysis unavailable; using note-based fallback:", (error as Error).message);
      analysis = fallbackDiagnosis(description);
      analysisSource = "fallback";
    }
    const ticket: Ticket = {
      id,
      createdAt: new Date().toISOString(),
      location,
      residentName,
      imageUrl: `/uploads/${imageFilename}`,
      description,
      ...analysis,
      vendor: vendors[analysis.category]
    };
    const tickets = await readTickets();
    tickets.unshift(ticket);
    await saveTickets(tickets);
    res.status(201).json({ ticket, analysisSource });
  } catch (error) { next(error); }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: "Something went wrong while creating this ticket." });
});

app.listen(port, () => console.log(`Property Support is running at http://localhost:${port}`));
