// src/models/AngelTokens.ts
import mongoose, { Document, Schema } from "mongoose";

export interface IAngelTokens extends Document {
  userId: mongoose.Types.ObjectId;
  clientcode: string;
  jwtToken?: string;
  refreshToken?: string;
  feedToken?: string;
  expiresAt?: Date;
}

const AngelTokensSchema = new Schema<IAngelTokens>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  clientcode: { type: String, required: true, index: true },
  jwtToken: String,
  refreshToken: String,
  feedToken: String,
  expiresAt: Date
}, { timestamps: true });

// Make userId + clientcode unique together
AngelTokensSchema.index({ userId: 1, clientcode: 1 }, { unique: true });

const AngelTokensModel = mongoose.models.AngelTokens || mongoose.model<IAngelTokens>("AngelTokens", AngelTokensSchema);

// 🔥 Fix: Drop the old unique index on clientcode if it exists
(async () => {
  try {
    await (AngelTokensModel as any).collection.dropIndex('clientcode_1');
    console.log('✅ Dropped old unique index clientcode_1');
  } catch (e) {
    // Index might not exist, ignore
  }
})();

export default AngelTokensModel as mongoose.Model<IAngelTokens>;
