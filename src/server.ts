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

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) {
  console[level](JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }));
}

function errorDetails(error: unknown) {
  if (!(error instanceof Error)) return { errorType: typeof error };
  return {
    errorType: error.name,
    errorCode: (error as NodeJS.ErrnoException).code,
    causeCode: (error.cause as NodeJS.ErrnoException | undefined)?.code
  };
}

function startStage(res: express.Response, operation: string, fields: Record<string, unknown> = {}) {
  const startedAt = performance.now();
  const { requestId, ticketId } = res.locals;
  const context = { requestId, ticketId, operation };
  res.locals.operation = operation;
  log("info", "ticket.stage_started", { ...context, ...fields });
  return (result: Record<string, unknown> = {}) => {
    log("info", "ticket.stage_completed", {
      ...context,
      durationMs: Math.round(performance.now() - startedAt),
      ...result
    });
  };
}

type Category = "Plumbing" | "Heating" | "Doors & locks" | "Electrical" | "Appliances" | "General maintenance";
const urgencies = ["Low", "Medium", "High"] as const;

type Ticket = {
  id: string;
  createdAt: string;
  location: string;
  residentName: string;
  imageUrl: string;
  description: string;
  category: Category;
  diagnosis: string;
  urgency: typeof urgencies[number];
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
  fileFilter: (req, file, callback) => {
    const accepted = file.mimetype.startsWith("image/");
    if (!accepted) {
      log("warn", "ticket.upload_rejected", {
        requestId: req.res?.locals.requestId,
        operation: "parse_upload",
        reason: "unsupported_media_type"
      });
    }
    callback(null, accepted);
  }
}).single("image");

async function readTickets(res: express.Response): Promise<Ticket[]> {
  const finishRead = startStage(res, "read_tickets");
  try {
    const tickets = JSON.parse(await fs.readFile(ticketFile, "utf8")) as Ticket[];
    finishRead({ storageFileExists: true, ticketCount: Array.isArray(tickets) ? tickets.length : undefined });
    return tickets;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    finishRead({ storageFileExists: false, ticketCount: 0 });
    return [];
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function analyzeIssue(imageBase64: string, description: string, res: express.Response) {
  const finishCall = startStage(res, "call_ollama");
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
  finishCall({ status: response.status, ok: response.ok });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Ollama returned ${response.status}`);
  }
  const finishDecode = startStage(res, "decode_ollama_response");
  const body: unknown = await response.json();
  if (!isJsonObject(body) || !isJsonObject(body.message) || typeof body.message.content !== "string") {
    throw new Error("Ollama response is missing text content");
  }
  const result: unknown = JSON.parse(body.message.content);
  finishDecode();

  const finishValidation = startStage(res, "validate_ollama_result");
  if (!isJsonObject(result)) throw new Error("Ollama triage must be a JSON object");

  const category = categories.find(value => value === result.category);
  const urgency = urgencies.find(value => value === result.urgency);
  const diagnosis = typeof result.diagnosis === "string" ? result.diagnosis.trim().slice(0, 160) : "";
  const fallbackFields = [];
  if (!category) fallbackFields.push("category");
  if (!urgency) fallbackFields.push("urgency");
  if (!diagnosis) fallbackFields.push("diagnosis");
  finishValidation({ fallbackFields });
  if (!category && !urgency && !diagnosis) throw new Error("Ollama triage has no usable fields");
  if (category && urgency && diagnosis) return { category, urgency, diagnosis };

  const finishFallback = startStage(res, "fill_missing_analysis_fields", { fallbackFields });
  const fallback = fallbackDiagnosis(description);
  finishFallback();
  return {
    category: category ?? fallback.category,
    diagnosis: diagnosis || fallback.diagnosis,
    urgency: urgency ?? fallback.urgency
  };
}

const app = express();
app.use("/api/tickets", (req, res, next) => {
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  const method = req.method;
  res.locals.requestId = requestId;
  res.locals.operation = "parse_request";
  log("info", "ticket.request_started", { requestId, method });
  res.once("close", () => {
    const durationMs = Math.round(performance.now() - startedAt);
    if (res.writableFinished) {
      log("info", "ticket.request_completed", { requestId, ticketId: res.locals.ticketId, method, status: res.statusCode, durationMs });
    } else {
      log("warn", "ticket.request_closed_early", {
        requestId,
        ticketId: res.locals.ticketId,
        operation: res.locals.operation,
        method,
        durationMs
      });
    }
  });
  next();
});
app.use(express.json());
app.use(express.static(publicDir));
app.use("/uploads", express.static(uploadDir));

app.get("/api/tickets", async (_req, res, next) => {
  try {
    const tickets = await readTickets(res);
    res.locals.operation = "send_response";
    res.json(tickets);
  } catch (error) { next(error); }
});

app.post("/api/tickets", (req, res, next) => {
  const finishUpload = startStage(res, "parse_upload");
  upload(req, res, (error: unknown) => {
    if (error) return next(error);
    finishUpload({ imageReceived: Boolean(req.file), imageBytes: req.file?.size });
    next();
  });
}, async (req, res, next) => {
  const requestId = res.locals.requestId as string;
  try {
    const finishValidation = startStage(res, "validate_ticket");
    if (!req.file) {
      log("warn", "ticket.validation_failed", { requestId, operation: "validate_ticket", reason: "missing_or_unsupported_image" });
      return res.status(400).json({ error: "Please upload an image of the issue." });
    }
    const description = (req.body.description ?? "").trim();
    const location = (req.body.location ?? "").trim();
    const residentName = (req.body.residentName ?? "").trim();
    if (!location || !residentName) {
      const missingFields = [];
      if (!location) missingFields.push("location");
      if (!residentName) missingFields.push("residentName");
      log("warn", "ticket.validation_failed", { requestId, operation: "validate_ticket", reason: "missing_required_fields", missingFields });
      return res.status(400).json({ error: "Location and resident name are required." });
    }
    finishValidation({ hasDescription: Boolean(description) });

    const finishNormalization = startStage(res, "normalize_image", { inputBytes: req.file.size });
    let normalizedPhoto: Buffer;
    try {
      normalizedPhoto = await normalizeIssuePhoto(req.file.buffer);
    } catch (error) {
      log("warn", "ticket.validation_failed", { requestId, operation: "normalize_image", reason: "unreadable_image" });
      return res.status(400).json({ error: (error as Error).message });
    }
    finishNormalization({ outputBytes: normalizedPhoto.length, format: "jpeg" });

    const id = `PS-${crypto.randomInt(1000, 10000)}`;
    res.locals.ticketId = id;
    const finishImageStore = startStage(res, "store_image");
    const imageFilename = `${id}-${crypto.randomUUID()}.jpg`;
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(path.join(uploadDir, imageFilename), normalizedPhoto);
    finishImageStore({ imageBytes: normalizedPhoto.length });

    let analysis;
    let analysisSource: "ollama" | "fallback" = "ollama";
    const analysisStartedAt = performance.now();
    try {
      analysis = await analyzeIssue(normalizedPhoto.toString("base64"), description, res);
    } catch (error) {
      log("warn", "ollama.analysis_fallback", {
        requestId,
        ticketId: id,
        operation: res.locals.operation,
        durationMs: Math.round(performance.now() - analysisStartedAt),
        ...errorDetails(error)
      });
      const finishFallback = startStage(res, "classify_from_note");
      analysis = fallbackDiagnosis(description);
      analysisSource = "fallback";
      finishFallback({ category: analysis.category, urgency: analysis.urgency });
    }

    const finishAssignment = startStage(res, "assign_vendor", { category: analysis.category, urgency: analysis.urgency, analysisSource });
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
    finishAssignment({ vendor: ticket.vendor.name });

    const tickets = await readTickets(res);
    const finishSave = startStage(res, "save_tickets");
    tickets.unshift(ticket);
    await saveTickets(tickets);
    finishSave({ ticketCount: tickets.length });
    log("info", "ticket.created", { requestId, ticketId: id, analysisSource });
    res.locals.operation = "send_response";
    res.status(201).json({ ticket, analysisSource });
  } catch (error) { next(error); }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log("error", "request.failed", {
    requestId: res.locals.requestId,
    ticketId: res.locals.ticketId,
    operation: res.locals.operation,
    ...errorDetails(error)
  });
  res.status(500).json({ error: "Something went wrong while creating this ticket." });
});

const server = app.listen(port, () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  log("info", "server.started", { url: `http://localhost:${listeningPort}` });
});
