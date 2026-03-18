import { Router } from "express";
import bcrypt from "bcrypt";
import {
  criarUsuario,
  buscarUsuarioPorId,
  listarPerfisDoUsuario,
  alterarPerfil,
  atualizarUsuario,
  atualizarStatus,
  db,
} from "../database/db.js";
import { autenticar } from "../middlewares/auth.js";

const router = Router();

// ─── Rotas públicas: GET / e POST / ───────────────────────────────────────
// Todas as demais rotas abaixo do comentário "Rotas protegidas" exigem token.


// ─── Helpers ───────────────────────────────────────────────────────────────

/** Retorna 404 se o usuário não existir */
function requireUsuario(id, res) {
  const usuario = buscarUsuarioPorId(id);
  if (!usuario) {
    res.status(404).json({ erro: "Usuário não encontrado." });
    return null;
  }
  return usuario;
}

/** Wrapper para capturar erros síncronos e encaminhar ao handler de erros */
const asyncHandler = (fn) => (req, res, next) => {
  try {
    fn(req, res, next);
  } catch (err) {
    next(err);
  }
};

// ─── GET /usuarios ─────────────────────────────────────────────────────────
// Lista todos os usuários (sem senha).
// Query params opcionais: ?status=online|offline|away|busy
router.get(
  "/",
  asyncHandler((req, res) => {
    const { status } = req.query;

    const validos = ["online", "offline", "away", "busy"];
    let usuarios;

    if (status) {
      if (!validos.includes(status)) {
        return res.status(400).json({
          erro: `Status inválido. Use: ${validos.join(", ")}.`,
        });
      }
      usuarios = db
        .prepare(
          `SELECT id, nome, nickname, email, imageProfile, imageCover, bio, status, created_at, updated_at
           FROM usuarios WHERE status = ?`
        )
        .all(status);
    } else {
      usuarios = db
        .prepare(
          `SELECT id, nome, nickname, email, imageProfile, imageCover, bio, status, created_at, updated_at
           FROM usuarios`
        )
        .all();
    }

    res.json(usuarios);
  })
);

// ─── Rotas protegidas (exigem token JWT) ──────────────────────────────────
router.use(autenticar);

// ─── GET /usuarios/:id ─────────────────────────────────────────────────────
// Retorna um usuário com seus perfis.
router.get(
  "/:id",
  asyncHandler((req, res) => {
    const usuario = requireUsuario(req.params.id, res);
    if (!usuario) return;

    const perfis = listarPerfisDoUsuario(usuario.id);
    res.json({ ...usuario, perfis });
  })
);

// ─── POST /usuarios ────────────────────────────────────────────────────────
// Cria um novo usuário. Perfil padrão: "usuario".
// Body obrigatório: nome, nickname, email, senha
// Body opcional:    imageProfile, imageCover, bio, status
router.post(
  "/",
  asyncHandler((req, res) => {
    const { nome, nickname, email, senha, imageProfile, imageCover, bio, status } = req.body;

    // Validação dos campos obrigatórios
    const faltando = [];
    if (!nome)     faltando.push("nome");
    if (!nickname) faltando.push("nickname");
    if (!email)    faltando.push("email");
    if (!senha)    faltando.push("senha");

    if (faltando.length) {
      return res.status(400).json({
        erro: `Campos obrigatórios ausentes: ${faltando.join(", ")}.`,
      });
    }

    // Hash da senha
    const senhaHash = bcrypt.hashSync(senha, 10);

    const { id } = criarUsuario({
      nome,
      nickname,
      email,
      senhaHash,
      imageProfile,
      imageCover,
      bio,
      status,
    });

    const novoUsuario = buscarUsuarioPorId(id);
    const perfis = listarPerfisDoUsuario(id);

    res.status(201).json({ ...novoUsuario, perfis });
  })
);

// ─── PUT /usuarios/:id ─────────────────────────────────────────────────────
// Atualiza campos editáveis: nome, nickname, imageProfile, imageCover, bio, status.
// Campos não permitidos (email, senha, perfil) são ignorados silenciosamente.
router.put(
  "/:id",
  asyncHandler((req, res) => {
    const usuario = requireUsuario(req.params.id, res);
    if (!usuario) return;

    const { nome, nickname, imageProfile, imageCover, bio, status } = req.body;
    const campos = { nome, nickname, imageProfile, imageCover, bio, status };

    // Remove chaves undefined para não substituir por null
    Object.keys(campos).forEach((k) => campos[k] === undefined && delete campos[k]);

    if (Object.keys(campos).length === 0) {
      return res.status(400).json({
        erro: "Nenhum campo editável informado. Campos aceitos: nome, nickname, imageProfile, imageCover, bio, status.",
      });
    }

    atualizarUsuario(usuario.id, campos);

    const atualizado = buscarUsuarioPorId(usuario.id);
    const perfis = listarPerfisDoUsuario(usuario.id);
    res.json({ ...atualizado, perfis });
  })
);

// ─── PATCH /usuarios/:id/status ────────────────────────────────────────────
// Atualiza somente o status do usuário.
// Body: { status: "online" | "offline" | "away" | "busy" }
router.patch(
  "/:id/status",
  asyncHandler((req, res) => {
    const usuario = requireUsuario(req.params.id, res);
    if (!usuario) return;

    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ erro: 'Campo "status" é obrigatório.' });
    }

    atualizarStatus(usuario.id, status);
    res.json({ id: usuario.id, status });
  })
);

// ─── PATCH /usuarios/:id/perfil ────────────────────────────────────────────
// Altera o perfil de um usuário. Requer que o solicitante seja administrador.
// Body: { adminId: string, novoPerfil: "administrador" | "moderador" | "usuario" }
router.patch(
  "/:id/perfil",
  asyncHandler((req, res) => {
    const target = requireUsuario(req.params.id, res);
    if (!target) return;

    const { adminId, novoPerfil } = req.body;

    if (!adminId || !novoPerfil) {
      return res.status(400).json({
        erro: 'Campos "adminId" e "novoPerfil" são obrigatórios.',
      });
    }

    if (!buscarUsuarioPorId(adminId)) {
      return res.status(404).json({ erro: "Administrador não encontrado." });
    }

    alterarPerfil({ adminId, targetUsuarioId: target.id, novoPerfil });

    const perfis = listarPerfisDoUsuario(target.id);
    res.json({ id: target.id, perfis });
  })
);

// ─── DELETE /usuarios/:id ──────────────────────────────────────────────────
// Remove o usuário e seus vínculos de perfil (CASCADE).
router.delete(
  "/:id",
  asyncHandler((req, res) => {
    const usuario = requireUsuario(req.params.id, res);
    if (!usuario) return;

    db.prepare(`DELETE FROM usuarios WHERE id = ?`).run(usuario.id);
    res.status(204).send();
  })
);

// ─── Handler de erros ──────────────────────────────────────────────────────
// Captura erros lançados pelas funções do database.js e converte em respostas HTTP.
router.use((err, req, res, _next) => {
  const msg = err.message ?? "Erro interno.";

  // Conflitos conhecidos (duplicatas, permissões)
  if (
    msg.includes("já está em uso") ||
    msg.includes("já está cadastrado") ||
    msg.includes("não existe")
  ) {
    return res.status(409).json({ erro: msg });
  }

  if (msg.includes("Apenas administradores")) {
    return res.status(403).json({ erro: msg });
  }

  if (msg.includes("inválido") || msg.includes("válido")) {
    return res.status(400).json({ erro: msg });
  }

  console.error("[usuarios.routes]", err);
  res.status(500).json({ erro: "Erro interno do servidor." });
});

export default router;
