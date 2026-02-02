
import knex from "knex";
import dotenv from "dotenv";

dotenv.config();

const Knex = knex({
  client: "mysql2",
  connection: {
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  },
  pool: { min: 0, max: 10 },
});

export default Knex;





// import knex from 'knex';
// import dotenv from 'dotenv';
// dotenv.config();

// // Use DATABASE_URL or discrete vars
// const Knex = knex({
//   client: 'pg',
//   connection: process.env.DATABASE_URL || {
//     host: process.env.DB_HOST || '127.0.0.1',
//     port: Number(process.env.DB_PORT || 5432),
//     user: process.env.DB_USER || 'postgres',
//     password: process.env.DB_PASSWORD || '123',
//     database: process.env.DB_NAME || 'OSL'
//   },
//   pool: { min: 0, max: 10 }
// });

// export default Knex;

