"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProductDetails = exports.getProductList = void 0;
const Strategy_1 = __importDefault(require("../models/Strategy"));
const getProductList = async (req, res) => {
    try {
        const strategies = await Strategy_1.default.find().sort({ created_at: -1 });
        // Map strategies to the format expected by the frontend ProductListView
        const products = strategies.map(s => ({
            id: s._id,
            name: s.strategy_name,
            serviceName: s.strategy_name,
            category: s.segment,
            segment: s.segment,
            lotSize: "1", // Default lot size
            subDescription: s.strategy_description || '',
            createdAt: s.created_at,
            // Add default values for required fields in IProductItem to avoid frontend crashes
            inventoryType: 'in stock',
            publish: 'published',
            price: 0,
            quantity: 100,
            available: 100,
            coverUrl: '',
            images: [],
            tags: [],
            reviews: [],
            totalRatings: 0,
            totalReviews: 0,
        }));
        res.status(200).json({
            status: true,
            products: products
        });
    }
    catch (err) {
        res.status(500).json({ status: false, error: err.message });
    }
};
exports.getProductList = getProductList;
const getProductDetails = async (req, res) => {
    try {
        const { id } = req.query; // Usually passed as query param in details endpoint for this template
        const strategy = await Strategy_1.default.findById(id || req.params.id);
        if (!strategy) {
            return res.status(404).json({ status: false, error: "Strategy/Product not found" });
        }
        const product = {
            id: strategy._id,
            name: strategy.strategy_name,
            category: strategy.segment,
            description: strategy.strategy_description || '',
            createdAt: strategy.created_at,
            inventoryType: 'in stock',
            publish: 'published',
            price: 0,
            quantity: 100,
            available: 100,
            coverUrl: '',
            images: [],
            tags: [],
            reviews: [],
            totalRatings: 0,
            totalReviews: 0,
        };
        res.status(200).json({ status: true, product });
    }
    catch (err) {
        res.status(500).json({ status: false, error: err.message });
    }
};
exports.getProductDetails = getProductDetails;
