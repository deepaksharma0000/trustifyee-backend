import mongoose, { Document, Schema } from "mongoose";

export interface IAliceTokens extends Document {
  clientcode: string;      
  aliceUserId?: string;    
  aliceClientId?: string;  
  sessionId: string;       
  accessToken?: string;
  expiresAt?: Date;
}

const AliceTokensSchema = new Schema<IAliceTokens>(
  {
    clientcode: { type: String, required: true, unique: true, index: true },
    sessionId: { type: String, required: true },
    accessToken: { type: String },
    expiresAt: { type: Date }
  },
  { timestamps: true }
);

export default mongoose.models.AliceTokens ||
  mongoose.model<IAliceTokens>("AliceTokens", AliceTokensSchema);
