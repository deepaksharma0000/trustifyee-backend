import mongoose, { Document, Schema } from "mongoose";

export interface IUpstoxTokens extends Document {
  userId: string;          
  accessToken: string;
  refreshToken?: string;
  extendedToken?: string;
  email?: string;
  userName?: string;
  exchanges?: string[];
  products?: string[];
  orderTypes?: string[];
  expiresAt?: Date;   
}

const UpstoxTokensSchema = new Schema<IUpstoxTokens>(
  {
    userId: { type: String, required: true, unique: true, index: true },
    accessToken: { type: String, required: true },
    refreshToken: String,
    extendedToken: String,
    email: String,
    userName: String,
    exchanges: [String],
    products: [String],
    orderTypes: [String],
    expiresAt: Date
  },
  { timestamps: true }
);

// Add index for expiry
UpstoxTokensSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.UpstoxTokens ||
  mongoose.model<IUpstoxTokens>("UpstoxTokens", UpstoxTokensSchema);