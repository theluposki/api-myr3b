import { Router } from 'express';
import authRouter     from './auth.js';
import usuariosRouter from './usuarios.js';

const router = Router();

router.use('/auth',     authRouter);
router.use('/usuarios', usuariosRouter);

export default router;
