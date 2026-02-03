import { Request, Response } from 'express';
import Strategy from '../models/Strategy';
import Joi from 'joi';

const strategySchema = Joi.object({
    strategy_name: Joi.string().min(3).max(150).required(),
    segment: Joi.string().required(),
    strategy_description: Joi.string().allow("", null),
});

export const addStrategy = async (req: Request, res: Response) => {
    try {
        const { error } = strategySchema.validate(req.body);
        if (error) return res.status(400).json({ status: false, error: error.message });

        const newStrategy = new Strategy(req.body);
        await newStrategy.save();

        res.status(201).json({
            status: true,
            message: "Strategy added successfully",
            data: newStrategy
        });

    } catch (err: any) {
        res.status(500).json({ status: false, error: err.message });
    }
}

export const getStrategies = async (req: Request, res: Response) => {
    try {
        const strategies = await Strategy.find().sort({ _id: -1 });
        res.status(200).json({ status: true, data: strategies });
    } catch (err: any) {
        res.status(500).json({ status: false, error: err.message });
    }
}

export const getStrategyById = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const strategy = await Strategy.findById(id);

        if (!strategy) return res.status(404).json({ status: false, error: "Strategy not found" });

        res.status(200).json({ status: true, data: strategy });
    } catch (err: any) {
        res.status(500).json({ status: false, error: err.message });
    }
}
