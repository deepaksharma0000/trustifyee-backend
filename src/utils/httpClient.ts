// src/utils/httpClient.ts
import axios from "axios";

export const httpClient = axios.create({
  timeout: 10_000,
});

httpClient.interceptors.response.use(
  (res) => res,
  (err) => {
    // yahan central logging / error formatting kar sakte ho
    return Promise.reject(err);
  }
);
