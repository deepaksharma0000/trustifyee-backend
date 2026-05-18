// src/models/StartupTelemetry.ts
import mongoose, { Schema, Document } from "mongoose";

export interface IStartupTelemetry extends Document {
  correlationId: string;
  timestamp: Date;
  startupDurationMs: number;
  dependencyLatencyMs: Record<string, number>;
  reconnectAttempts: number;
  redisRttMs: number;
  mongoRttMs: number;
  status: string; // HEALTHY, DEGRADED, FAILED
  failures: string[];
  degradedFrequency: number;
  failureFrequency: number;
  integritySignature: string;
}

const StartupTelemetrySchema = new Schema<IStartupTelemetry>(
  {
    correlationId: { type: String, required: true, unique: true, index: true },
    timestamp: { type: Date, default: Date.now },
    startupDurationMs: { type: Number, required: true },
    dependencyLatencyMs: { type: Schema.Types.Mixed, required: true },
    reconnectAttempts: { type: Number, required: true, default: 0 },
    redisRttMs: { type: Number, required: true },
    mongoRttMs: { type: Number, required: true },
    status: { type: String, required: true },
    failures: { type: [String], required: true },
    degradedFrequency: { type: Number, required: true, default: 0 },
    failureFrequency: { type: Number, required: true, default: 0 },
    integritySignature: { type: String, required: true },
  },
  { timestamps: true }
);

const StartupTelemetryModel =
  mongoose.models.StartupTelemetry ||
  mongoose.model<IStartupTelemetry>("StartupTelemetry", StartupTelemetrySchema);

export default StartupTelemetryModel as mongoose.Model<IStartupTelemetry>;
