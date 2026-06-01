import express from "express";
import cors from "cors";
import testRoutes from "./routes/test.routes.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/test", testRoutes);

app.get("/", (req, res) => {
    res.send("PingMe API Running 🚀");
});

export default app;