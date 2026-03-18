import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { db } from "../database/db.js";

const router = Router();

const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES ?? "8h";

if (!JWT_SECRET) {
  throw new Error("Variável de ambiente JWT_SECRET não definida.");
}

// ─── POST /auth/login ──────────────────────────────────────────────────────
// Body: { email, senha }
// Retorna: { token, usuario }
router.post("/login", async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ erro: 'Campos "email" e "senha" são obrigatórios.' });
  }

  // Busca usuário com senha (única rota que precisa do campo senha)
  const usuario = db
    .prepare(`SELECT id, nome, nickname, email, senha, imageProfile, imageCover, bio, status FROM usuarios WHERE email = ?`)
    .get(email);

  // Mesma mensagem para email inexistente e senha errada — evita enumeração de contas
  const ERRO_CREDENCIAIS = "E-mail ou senha inválidos.";

  if (!usuario) {
    return res.status(401).json({ erro: ERRO_CREDENCIAIS });
  }

  const senhaCorreta = await bcrypt.compare(senha, usuario.senha);
  if (!senhaCorreta) {
    return res.status(401).json({ erro: ERRO_CREDENCIAIS });
  }

  // Busca perfis para incluir no payload do token
  const perfis = db
    .prepare(`SELECT p.nome FROM perfis p JOIN usuario_perfil up ON up.perfil_id = p.id WHERE up.usuario_id = ?`)
    .all(usuario.id)
    .map((p) => p.nome);

  const payload = {
    id:     usuario.id,
    email:  usuario.email,
    perfis,
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });

  // Remove a senha antes de retornar o objeto do usuário
  const { senha: _, ...usuarioSemSenha } = usuario;

  return res.status(200).json({
    token,
    expiresIn: JWT_EXPIRES,
    usuario: { ...usuarioSemSenha, perfis },
  });
});

export default router;
