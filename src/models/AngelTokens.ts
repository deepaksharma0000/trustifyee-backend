// src/models/AngelTokens.ts
import mongoose, { Document, Schema } from "mongoose";

export interface IAngelTokens extends Document {
  clientcode: string;
  jwtToken?: string;
  refreshToken?: string;
  feedToken?: string;
  expiresAt?: Date;
}

const AngelTokensSchema = new Schema<IAngelTokens>({
  clientcode: { type: String, required: true, unique: true, index: true },
  jwtToken: String,
  refreshToken: String,
  feedToken: String,
  expiresAt: Date
}, { timestamps: true });

const AngelTokensModel = mongoose.models.AngelTokens || mongoose.model<IAngelTokens>("AngelTokens", AngelTokensSchema);
export default AngelTokensModel as mongoose.Model<IAngelTokens>;
