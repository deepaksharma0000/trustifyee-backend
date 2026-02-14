import { Router } from 'express';
import { HelpController } from '../controllers/HelpController';

const router = Router();

router.post('/submit', HelpController.submitRequest);

export default router;
