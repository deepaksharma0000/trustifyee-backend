import dotenv from "dotenv";
import mysql from "mysql2/promise";

dotenv.config();

// Create MySQL connection pool
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT) || 3307,
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "darixo_solution",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});
// Test connection
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log("✅ MySQL DB connected...!!!");
    connection.release();
  } catch (err) {
    console.error("❌ MySQL DB connection failed:", err.message);
  }
})();

export default pool;


// import dotenv from 'dotenv';
// import pkg from 'pg';
// dotenv.config();

// const { Pool } = pkg;

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   host: process.env.DB_HOST || '127.0.0.1',
//   port: Number(process.env.DB_PORT || 5432),
//   user: process.env.DB_USER || 'postgres',
//   password: process.env.DB_PASSWORD || '123',
//   database: process.env.DB_NAME || 'OSL',
// });


// pool.connect();

// pool.on("connect", () => {
//   console.log("DB connection...!!!");
// });
// pool.on("end", () => {
//   console.log("DB end connection...!!!");
// });
// pool.query("SET search_path to 'public';");

// export default pool;


