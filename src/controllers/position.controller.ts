import { Request, Response } from "express";
import { Position } from "../models/Position.model";

export const getOpenPositions = async (req: Request, res: Response) => {
  try {
    const { clientcode } = req.params;

    const positions = await Position.find({
      clientcode,
      status: { $in: ["OPEN", "COMPLETE"] },
    }).sort({ createdAt: -1 });

    res.json({
      ok: true,
      data: positions,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      message: "Failed to fetch open positions",
    });
  }
};
export const closePosition = async (
  req: Request,
  res: Response
) => {
  const { orderid } = req.body;

  await Position.findOneAndUpdate(
    { orderid },
    { status: "CLOSED" }
  );

  res.json({ ok: true });
};
