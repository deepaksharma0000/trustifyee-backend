import mongoose, { Document, Schema } from "mongoose";

export interface IAngelTokens extends Document {
  userId: mongoose.Types.ObjectId;
  clientcode: string;
  jwtToken?: string;
  refreshToken?: string;
  feedToken?: string;
  apiKey?: string;
  expiresAt?: Date;
}

const AngelTokensSchema = new Schema<IAngelTokens>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    clientcode: { type: String, required: true, index: true },
    jwtToken: String,
    refreshToken: String,
    feedToken: String,
    apiKey: String,
    expiresAt: Date,
  },
  { timestamps: true }
);

AngelTokensSchema.index({ userId: 1, clientcode: 1 }, { unique: true });

const AngelTokensModel =
  mongoose.models.AngelTokens ||
  mongoose.model<IAngelTokens>("AngelTokens", AngelTokensSchema);

export default AngelTokensModel as mongoose.Model<IAngelTokens>;
