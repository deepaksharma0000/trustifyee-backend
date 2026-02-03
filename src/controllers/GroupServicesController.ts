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
        const { name, segment_id } = req.body;
        if (!name || !segment_id) return res.status(400).json({ message: "Name and segment_id are required", status: false });

        const newGroup = new Group({ name, segment_id });
        await newGroup.save();

        res.status(201).json({
            message: "Group created successfully!",
            group_id: newGroup._id,
            status: true,
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getAllGroups = async (req: Request, res: Response) => {
    try {
        const groups = await Group.find().populate('segment_id', 'name').sort({ _id: -1 });

        const formatted = groups.map((g: any) => ({
            value: g._id,
            label: g.name,
            segment_name: g.segment_id?.name,
            segment_id: g.segment_id?._id,
            created_at: g.created_at,
            updated_at: g.updated_at
        }));

        res.status(200).json({
            message: "Groups fetched successfully!",
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
