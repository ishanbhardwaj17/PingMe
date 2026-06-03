import Redis from "ioredis";

const connection = new Redis({
  host: "127.0.0.1",
  port: 6379,
  maxRetriesPerRequest: null,
});

connection.on("connect", () => {
  console.log("Redis Connected");
});

connection.on("error", (err) => {
  console.log("Redis Error:", err.message);
});

export default connection;