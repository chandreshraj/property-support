# Property Support

A small property-maintenance request app. Residents upload an issue photo, Ollama classifies the problem, and the app chooses a matching vendor. Requests are saved locally and appear in the ticket history.

## Run it

1. Copy `.env.example` to `.env` and configure Ollama, including your API key:

   ```env
   OLLAMA_BASE_URL=http://localhost:11434
   OLLAMA_MODEL=gemma4:12b
   OLLAMA_API_KEY=your_ollama_api_key
   ```

   The app sends this value as a bearer token in every request to Ollama. For a local Ollama instance, pull a vision-capable model first:

   ```bash
   ollama pull gemma4:12b
   ```

2. Install and start the app:

   ```bash
   npm install
   npm run dev
   ```

3. Open `http://localhost:3000`.

For a production-style local run, use `npm run build` followed by `npm start`.

## Configuration

| Variable | Description |
| --- | --- |
| `OLLAMA_BASE_URL` | Ollama server URL, defaulting to `http://localhost:11434`. |
| `OLLAMA_MODEL` | A vision-capable model, e.g. `gemma4:12b`. |
| `OLLAMA_API_KEY` | Ollama API key sent as a bearer token with each image-analysis request. |
| `PORT` | App port, defaulting to `3000`. |

Keep `.env` private; it is excluded from git. If Ollama is temporarily unavailable, the request is still saved and is routed from the resident’s written note. The confirmation screen makes that clear.

Tickets are stored in `data/tickets.json`. Submitted photos are normalized to JPEG and stored locally in `data/uploads/`; both are intentionally excluded from git.
