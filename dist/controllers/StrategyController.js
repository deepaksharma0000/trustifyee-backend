"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStrategyById = exports.getStrategies = exports.addStrategy = void 0;
const Strategy_1 = __importDefault(require("../models/Strategy"));
const joi_1 = __importDefault(require("joi"));
const strategySchema = joi_1.default.object({
    strategy_name: joi_1.default.string().min(3).max(150).required(),
    segment: joi_1.default.string().required(),
    strategy_description: joi_1.default.string().allow("", null),
});
const addStrategy = async (req, res) => {
    try {
        const { error } = strategySchema.validate(req.body);
        if (error)
            return res.status(400).json({ status: false, error: error.message });
        const newStrategy = new Strategy_1.default(req.body);
        await newStrategy.save();
        res.status(201).json({
            status: true,
            message: "Strategy added successfully",
            data: newStrategy
        });
    }
    catch (err) {
        res.status(500).json({ status: false, error: err.message });
    }
};
exports.addStrategy = addStrategy;
const getStrategies = async (req, res) => {
    try {
        const strategies = await Strategy_1.default.find().sort({ _id: -1 });
        res.status(200).json({ status: true, data: strategies });
    }
    catch (err) {
        res.status(500).json({ status: false, error: err.message });
    }
};
exports.getStrategies = getStrategies;
const getStrategyById = async (req, res) => {
    try {
        const { id } = req.params;
        const strategy = await Strategy_1.default.findById(id);
        if (!strategy)
            return res.status(404).json({ status: false, error: "Strategy not found" });
        res.status(200).json({ status: true, data: strategy });
    }
    catch (err) {
        res.status(500).json({ status: false, error: err.message });
    }
};
exports.getStrategyById = getStrategyById;
