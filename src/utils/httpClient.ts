// src/utils/httpClient.ts
import axios from "axios";
import { ipv4Agent } from "./httpAgent";

export const httpClient = axios.create({
  timeout: 10_000,
  httpsAgent: ipv4Agent,
});

httpClient.interceptors.response.use(
  (res) => res,
  (err) => {
    // yahan central logging / error formatting kar sakte ho
    return Promise.reject(err);
  }
);
