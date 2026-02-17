import express from 'express';
import type { Request, Response, NextFunction } from 'express';

const router = express.Router();

/**
 * GET home route
 */
router.get('/', (req: Request, res: Response, _next: NextFunction) => {
    res.json({ message: 'Welcome to QAToto API' });
});

export default router;
