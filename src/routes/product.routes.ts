import { Router } from 'express';
import { getProductList, getProductDetails } from '../controllers/ProductController';
import { auth } from '../middleware/auth.middleware';

const router = Router();

router.get('/list', auth, getProductList);
router.get('/details', auth, getProductDetails);

export default router;
