import express from "express";
import { runCheck } from "./checker.js";

const app = express();
const PORT = 3100;

app.use(express.static("public"));

app.get("/api/check", async (req, res) => {
  try {
    res.json(await runCheck());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`UI running at http://localhost:${PORT}`));