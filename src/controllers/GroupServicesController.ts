import { Request, Response } from 'express';
import { Group, Segment } from '../models/GroupServices';

export const getSegments = async (req: Request, res: Response) => {
    try {
        const segments = await Segment.find();
        // Mapping to match UI requirement: value/label
        const formatted = segments.map(s => ({
            value: s._id,
            label: s.name
        }));
        res.status(200).json({
            message: "Segments fetched successfully!",
            count: formatted.length,
            data: formatted,
            status: true,
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const addGroup = async (req: Request, res: Response) => {
    try {
        const { groupdetails, services_id } = req.body;
        const name = groupdetails?.name;

        if (!name) return res.status(400).json({ message: "Group Name is required", status: false });

        const newGroup = new Group({
            name,
            services: services_id || []
        });
        await newGroup.save();

        res.status(201).json({
            message: "successfully Add!",
            data: newGroup,
            status: true,
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getAllGroups = async (req: Request, res: Response) => {
    try {
        const groups = await Group.find().sort({ _id: -1 });

        const formatted = groups.map((g: any) => ({
            _id: g._id,
            name: g.name,
            description: g.description,
            result: g.services, // Mapping services to 'result' for backward compatibility with your example
            resultCount: g.services.length,
            createdAt: g.created_at,
            updatedAt: g.updated_at
        }));

        res.status(200).json({
            message: "Get All successfully",
            count: formatted.length,
            data: formatted,
            status: true,
        });

    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getGroupById = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const group: any = await Group.findById(id).populate('segment_id', 'name');

        if (!group) return res.status(404).json({ message: "Group not found", status: false });

        res.status(200).json({
            message: "Group fetched successfully!",
            data: {
                ...group.toObject(),
                segment_name: group.segment_id?.name
            },
            status: true,
        });

    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const deleteGroup = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const deleted = await Group.findByIdAndDelete(id);
        if (!deleted) return res.status(404).json({ message: "Group not found", status: false });

        res.status(200).json({
            message: "successfully Deleted!",
            status: true,
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}
