import mongoose, { Document, Schema } from "mongoose";

export interface IAliceTokens extends Document {
  userId?: mongoose.Types.ObjectId;
  clientcode: string;
  aliceUserId?: string;
  aliceClientId?: string;
  sessionId: string;
  accessToken?: string;
  expiresAt?: Date;
}

const AliceTokensSchema = new Schema<IAliceTokens>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    clientcode: { type: String, required: true, unique: true, index: true },
    sessionId: { type: String, required: true },
    accessToken: { type: String },
    expiresAt: { type: Date }
  },
  { timestamps: true }
);

const AliceTokensModel = mongoose.models.AliceTokens ||
  mongoose.model<IAliceTokens>("AliceTokens", AliceTokensSchema);

export default AliceTokensModel as mongoose.Model<IAliceTokens>;
