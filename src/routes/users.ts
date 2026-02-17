import express from 'express';
import type { Request, Response, NextFunction } from 'express';

const router = express.Router();

/**
 * GET users route
 */
router.get('/', (req: Request, res: Response, _next: NextFunction) => {
    res.json({ message: 'Users route' });
});

export default router;
