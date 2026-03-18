/**
 * Testes de integração — /usuarios + /auth
 *
 * Usa o test runner nativo do Node.js (node:test) + assert nativo.
 * Banco em memória (:memory:) isolado por suite, sem estado compartilhado.
 *
 * Execução:
 *   node --test --test-reporter=spec **\/*.test.js
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { DatabaseSync } from "node:sqlite";

const JWT_SECRET  = "segredo_de_teste";
const JWT_EXPIRES = "1h";

// ─── Banco em memória ──────────────────────────────────────────────────────

let db;

function criarBancoEmMemoria() {
  db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS perfis (
      id   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      nome TEXT NOT NULL UNIQUE CHECK (nome IN ('administrador', 'moderador', 'usuario'))
    );
    INSERT OR IGNORE INTO perfis (nome) VALUES ('administrador'), ('moderador'), ('usuario');

    CREATE TABLE IF NOT EXISTS usuarios (
      id           TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      nome         TEXT NOT NULL,
      nickname     TEXT NOT NULL UNIQUE,
      email        TEXT NOT NULL UNIQUE,
      senha        TEXT NOT NULL,
      imageProfile TEXT NOT NULL DEFAULT 'https://ui-avatars.com/api/?background=random',
      imageCover   TEXT NOT NULL DEFAULT 'https://placehold.co/1200x300/1a1a2e/white',
      bio          TEXT NOT NULL DEFAULT 'Olá! Estou usando este app.',
      status       TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline','away','busy')),
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TRIGGER IF NOT EXISTS trg_usuarios_updated_at
    AFTER UPDATE ON usuarios FOR EACH ROW
    BEGIN
      UPDATE usuarios SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = OLD.id;
    END;

    CREATE TABLE IF NOT EXISTS usuario_perfil (
      usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      perfil_id  TEXT NOT NULL REFERENCES perfis(id)   ON DELETE RESTRICT,
      PRIMARY KEY (usuario_id, perfil_id)
    );
  `);
  return db;
}

// ─── Helpers de banco ──────────────────────────────────────────────────────

function getPerfilId(nome) {
  return db.prepare(`SELECT id FROM perfis WHERE nome = ?`).get(nome)?.id;
}

function criarUsuarioDB({ nome, nickname, email, senha = "senha123", imageProfile, imageCover, bio, status }) {
  if (db.prepare(`SELECT 1 FROM usuarios WHERE nickname = ?`).get(nickname)) {
    throw new Error(`Nickname "${nickname}" já está em uso.`);
  }
  if (db.prepare(`SELECT 1 FROM usuarios WHERE email = ?`).get(email)) {
    throw new Error(`E-mail "${email}" já está cadastrado.`);
  }

  // Custo 4: mínimo válido pelo bcrypt, muito mais rápido em testes
  const senhaHash = bcrypt.hashSync(senha, 4);

  db.prepare(`
    INSERT INTO usuarios (nome, nickname, email, senha, imageProfile, imageCover, bio, status)
    VALUES (?, ?, ?, ?, COALESCE(?, 'https://ui-avatars.com/api/?background=random'),
            COALESCE(?, 'https://placehold.co/1200x300/1a1a2e/white'),
            COALESCE(?, 'Olá! Estou usando este app.'),
            COALESCE(?, 'offline'))
  `).run(nome, nickname, email, senhaHash, imageProfile ?? null, imageCover ?? null, bio ?? null, status ?? null);

  const { id } = db.prepare(`SELECT id FROM usuarios WHERE email = ?`).get(email);
  db.prepare(`INSERT INTO usuario_perfil (usuario_id, perfil_id) VALUES (?, ?)`).run(id, getPerfilId("usuario"));
  return id;
}

function promoverAdmin(usuarioId) {
  const perfilId = getPerfilId("administrador");
  db.prepare(`DELETE FROM usuario_perfil WHERE usuario_id = ?`).run(usuarioId);
  db.prepare(`INSERT INTO usuario_perfil (usuario_id, perfil_id) VALUES (?, ?)`).run(usuarioId, perfilId);
}

/** Gera token JWT válido apontando para o JWT_SECRET de teste */
function gerarToken(usuarioId, perfis = ["usuario"]) {
  return jwt.sign({ id: usuarioId, perfis }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// ─── App Express isolado ───────────────────────────────────────────────────

function criarApp() {
  const app = express();
  app.use(express.json());

  // Middleware de autenticação (replica autenticar.middleware.js)
  function autenticar(req, res, next) {
    const header = req.headers["authorization"];
    if (!header?.startsWith("Bearer ")) return res.status(401).json({ erro: "Token não fornecido." });
    try {
      req.usuario = jwt.verify(header.slice(7), JWT_SECRET);
      next();
    } catch (err) {
      res.status(401).json({ erro: err.name === "TokenExpiredError" ? "Token expirado." : "Token inválido." });
    }
  }

  function requireUsuario(id, res) {
    const u = db.prepare(`
      SELECT id, nome, nickname, email, imageProfile, imageCover, bio, status, created_at, updated_at
      FROM usuarios WHERE id = ?
    `).get(id);
    if (!u) { res.status(404).json({ erro: "Usuário não encontrado." }); return null; }
    return u;
  }

  function listarPerfis(usuarioId) {
    return db.prepare(`
      SELECT p.id, p.nome FROM perfis p
      JOIN usuario_perfil up ON up.perfil_id = p.id
      WHERE up.usuario_id = ?
    `).all(usuarioId);
  }

  const wrap = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };

  // ── POST /auth/login ──────────────────────────────────────────────────────
  app.post("/auth/login", async (req, res) => {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: 'Campos "email" e "senha" são obrigatórios.' });

    const usuario = db.prepare(
      `SELECT id, nome, nickname, email, senha, imageProfile, imageCover, bio, status FROM usuarios WHERE email = ?`
    ).get(email);

    const ERRO = "E-mail ou senha inválidos.";
    if (!usuario) return res.status(401).json({ erro: ERRO });

    const senhaCorreta = await bcrypt.compare(senha, usuario.senha);
    if (!senhaCorreta) return res.status(401).json({ erro: ERRO });

    const perfis = db.prepare(
      `SELECT p.nome FROM perfis p JOIN usuario_perfil up ON up.perfil_id = p.id WHERE up.usuario_id = ?`
    ).all(usuario.id).map((p) => p.nome);

    const token = jwt.sign({ id: usuario.id, email: usuario.email, perfis }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    const { senha: _, ...usuarioSemSenha } = usuario;
    res.status(200).json({ token, expiresIn: JWT_EXPIRES, usuario: { ...usuarioSemSenha, perfis } });
  });

  // ── Rotas públicas ────────────────────────────────────────────────────────

  app.get("/usuarios", wrap((req, res) => {
    const { status } = req.query;
    const validos = ["online", "offline", "away", "busy"];
    if (status && !validos.includes(status)) {
      return res.status(400).json({ erro: `Status inválido. Use: ${validos.join(", ")}.` });
    }
    const sql = status
      ? `SELECT id,nome,nickname,email,imageProfile,imageCover,bio,status,created_at,updated_at FROM usuarios WHERE status = ?`
      : `SELECT id,nome,nickname,email,imageProfile,imageCover,bio,status,created_at,updated_at FROM usuarios`;
    res.json(status ? db.prepare(sql).all(status) : db.prepare(sql).all());
  }));

  app.post("/usuarios", wrap((req, res) => {
    const { nome, nickname, email, senha, imageProfile, imageCover, bio, status } = req.body;
    const faltando = [];
    if (!nome)     faltando.push("nome");
    if (!nickname) faltando.push("nickname");
    if (!email)    faltando.push("email");
    if (!senha)    faltando.push("senha");
    if (faltando.length) return res.status(400).json({ erro: `Campos obrigatórios ausentes: ${faltando.join(", ")}.` });

    const id = criarUsuarioDB({ nome, nickname, email, senha, imageProfile, imageCover, bio, status });
    const novo = db.prepare(`SELECT id,nome,nickname,email,imageProfile,imageCover,bio,status,created_at,updated_at FROM usuarios WHERE id=?`).get(id);
    res.status(201).json({ ...novo, perfis: listarPerfis(id) });
  }));

  // ── Rotas protegidas ──────────────────────────────────────────────────────
  app.use(autenticar);

  app.get("/usuarios/:id", wrap((req, res) => {
    const u = requireUsuario(req.params.id, res);
    if (!u) return;
    res.json({ ...u, perfis: listarPerfis(u.id) });
  }));

  app.put("/usuarios/:id", wrap((req, res) => {
    const u = requireUsuario(req.params.id, res);
    if (!u) return;
    const permitidos = ["nome", "nickname", "imageProfile", "imageCover", "bio", "status"];
    const campos = Object.fromEntries(Object.entries(req.body).filter(([k, v]) => permitidos.includes(k) && v !== undefined));
    if (Object.keys(campos).length === 0) return res.status(400).json({ erro: "Nenhum campo editável informado." });
    if (campos.nickname) {
      const dup = db.prepare(`SELECT id FROM usuarios WHERE nickname = ?`).get(campos.nickname);
      if (dup && dup.id !== u.id) throw new Error(`Nickname "${campos.nickname}" já está em uso.`);
    }
    const sets = Object.keys(campos).map(k => `${k} = ?`).join(", ");
    db.prepare(`UPDATE usuarios SET ${sets} WHERE id = ?`).run(...Object.values(campos), u.id);
    const atualizado = db.prepare(`SELECT id,nome,nickname,email,imageProfile,imageCover,bio,status,created_at,updated_at FROM usuarios WHERE id=?`).get(u.id);
    res.json({ ...atualizado, perfis: listarPerfis(u.id) });
  }));

  app.patch("/usuarios/:id/status", wrap((req, res) => {
    const u = requireUsuario(req.params.id, res);
    if (!u) return;
    const { status } = req.body;
    if (!status) return res.status(400).json({ erro: 'Campo "status" é obrigatório.' });
    const validos = ["online", "offline", "away", "busy"];
    if (!validos.includes(status)) throw new Error(`Status inválido: ${status}`);
    db.prepare(`UPDATE usuarios SET status = ? WHERE id = ?`).run(status, u.id);
    res.json({ id: u.id, status });
  }));

  app.patch("/usuarios/:id/perfil", wrap((req, res) => {
    const target = requireUsuario(req.params.id, res);
    if (!target) return;
    const { adminId, novoPerfil } = req.body;
    if (!adminId || !novoPerfil) return res.status(400).json({ erro: 'Campos "adminId" e "novoPerfil" são obrigatórios.' });
    const admin = db.prepare(`SELECT id FROM usuarios WHERE id = ?`).get(adminId);
    if (!admin) return res.status(404).json({ erro: "Administrador não encontrado." });
    const adminPerfil = db.prepare(
      `SELECT 1 FROM usuario_perfil up JOIN perfis p ON p.id = up.perfil_id WHERE up.usuario_id = ? AND p.nome = 'administrador'`
    ).get(adminId);
    if (!adminPerfil) throw new Error("Apenas administradores podem alterar perfis.");
    const perfilId = getPerfilId(novoPerfil);
    if (!perfilId) throw new Error(`Perfil "${novoPerfil}" não existe.`);
    db.prepare(`DELETE FROM usuario_perfil WHERE usuario_id = ?`).run(target.id);
    db.prepare(`INSERT INTO usuario_perfil (usuario_id, perfil_id) VALUES (?, ?)`).run(target.id, perfilId);
    res.json({ id: target.id, perfis: listarPerfis(target.id) });
  }));

  app.delete("/usuarios/:id", wrap((req, res) => {
    const u = requireUsuario(req.params.id, res);
    if (!u) return;
    db.prepare(`DELETE FROM usuarios WHERE id = ?`).run(u.id);
    res.status(204).send();
  }));

  app.use((err, req, res, _next) => {
    const msg = err.message ?? "Erro interno.";
    if (msg.includes("já está em uso") || msg.includes("já está cadastrado") || msg.includes("não existe")) {
      return res.status(409).json({ erro: msg });
    }
    if (msg.includes("Apenas administradores")) return res.status(403).json({ erro: msg });
    if (msg.includes("inválido") || msg.includes("válido")) return res.status(400).json({ erro: msg });
    res.status(500).json({ erro: "Erro interno do servidor." });
  });

  return app;
}

// ─── Helper de requests ────────────────────────────────────────────────────

async function req(app, method, path, body, token) {
  const { default: supertest } = await import("supertest");
  let r = supertest(app)[method](path).set("Content-Type", "application/json");
  if (token) r = r.set("Authorization", `Bearer ${token}`);
  return body ? r.send(body) : r;
}

// ══════════════════════════════════════════════════════════════════════════════
// SUITES
// ══════════════════════════════════════════════════════════════════════════════

// ─── POST /auth/login ──────────────────────────────────────────────────────

describe("POST /auth/login", () => {
  let app, id;

  before(() => {
    criarBancoEmMemoria();
    app = criarApp();
    id = criarUsuarioDB({ nome: "Login User", nickname: "loginuser", email: "login@email.com", senha: "senha123" });
  });
  after(() => db.close());

  it("retorna token e dados do usuário com credenciais corretas", async () => {
    const res = await req(app, "post", "/auth/login", { email: "login@email.com", senha: "senha123" });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(res.body.expiresIn, JWT_EXPIRES);
    assert.ok(res.body.usuario);
    assert.equal(res.body.usuario.email, "login@email.com");
  });

  it("não expõe a senha na resposta", async () => {
    const res = await req(app, "post", "/auth/login", { email: "login@email.com", senha: "senha123" });
    assert.equal(res.body.usuario.senha, undefined);
  });

  it("token contém id, email e perfis no payload", async () => {
    const res = await req(app, "post", "/auth/login", { email: "login@email.com", senha: "senha123" });
    const payload = jwt.decode(res.body.token);
    assert.ok(payload.id);
    assert.equal(payload.email, "login@email.com");
    assert.ok(Array.isArray(payload.perfis));
    assert.ok(payload.perfis.includes("usuario"));
  });

  it("retorna perfis do usuário no objeto usuario", async () => {
    const res = await req(app, "post", "/auth/login", { email: "login@email.com", senha: "senha123" });
    assert.ok(Array.isArray(res.body.usuario.perfis));
    assert.ok(res.body.usuario.perfis.includes("usuario"));
  });

  it("retorna 401 para senha incorreta", async () => {
    const res = await req(app, "post", "/auth/login", { email: "login@email.com", senha: "errada" });
    assert.equal(res.status, 401);
    assert.match(res.body.erro, /inválidos/i);
  });

  it("retorna 401 para email inexistente (mesma mensagem — sem enumeração de contas)", async () => {
    const res = await req(app, "post", "/auth/login", { email: "naoexiste@email.com", senha: "senha123" });
    assert.equal(res.status, 401);
    assert.match(res.body.erro, /inválidos/i);
  });

  it("retorna 400 quando email está ausente", async () => {
    const res = await req(app, "post", "/auth/login", { senha: "senha123" });
    assert.equal(res.status, 400);
  });

  it("retorna 400 quando senha está ausente", async () => {
    const res = await req(app, "post", "/auth/login", { email: "login@email.com" });
    assert.equal(res.status, 400);
  });
});

// ─── Proteção JWT ──────────────────────────────────────────────────────────

describe("Proteção JWT", () => {
  let app, id;

  before(() => {
    criarBancoEmMemoria();
    app = criarApp();
    id = criarUsuarioDB({ nome: "Protegido", nickname: "protegido", email: "protegido@email.com" });
  });
  after(() => db.close());

  it("rota protegida sem token retorna 401", async () => {
    const res = await req(app, "get", `/usuarios/${id}`);
    assert.equal(res.status, 401);
    assert.match(res.body.erro, /não fornecido/i);
  });

  it("rota protegida com token inválido retorna 401", async () => {
    const res = await req(app, "get", `/usuarios/${id}`, undefined, "token.invalido.aqui");
    assert.equal(res.status, 401);
    assert.match(res.body.erro, /inválido/i);
  });

  it("rota protegida com token expirado retorna 401 com mensagem específica", async () => {
    const tokenExpirado = jwt.sign({ id, perfis: ["usuario"] }, JWT_SECRET, { expiresIn: -1 });
    const res = await req(app, "get", `/usuarios/${id}`, undefined, tokenExpirado);
    assert.equal(res.status, 401);
    assert.match(res.body.erro, /expirado/i);
  });

  it("rota protegida com token válido retorna 200", async () => {
    const res = await req(app, "get", `/usuarios/${id}`, undefined, gerarToken(id));
    assert.equal(res.status, 200);
  });

  it("GET /usuarios é pública — funciona sem token", async () => {
    const res = await req(app, "get", "/usuarios");
    assert.equal(res.status, 200);
  });

  it("POST /usuarios é pública — funciona sem token", async () => {
    const res = await req(app, "post", "/usuarios", {
      nome: "Público", nickname: "pub_user", email: "pub@email.com", senha: "abc",
    });
    assert.equal(res.status, 201);
  });
});

// ─── POST /usuarios ────────────────────────────────────────────────────────

describe("POST /usuarios", () => {
  let app;

  before(() => { criarBancoEmMemoria(); app = criarApp(); });
  after(() => db.close());

  it("cria usuário com campos obrigatórios e retorna 201", async () => {
    const res = await req(app, "post", "/usuarios", {
      nome: "João Silva", nickname: "joao", email: "joao@email.com", senha: "senha123",
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.nome, "João Silva");
    assert.equal(res.body.nickname, "joao");
    assert.equal(res.body.email, "joao@email.com");
    assert.equal(res.body.senha, undefined);
  });

  it("atribui perfil 'usuario' por padrão", async () => {
    const res = await req(app, "post", "/usuarios", {
      nome: "Ana Costa", nickname: "ana", email: "ana@email.com", senha: "abc",
    });
    assert.equal(res.status, 201);
    assert.ok(Array.isArray(res.body.perfis));
    assert.equal(res.body.perfis.length, 1);
    assert.equal(res.body.perfis[0].nome, "usuario");
  });

  it("aplica valores padrão (status, bio, imagens)", async () => {
    const res = await req(app, "post", "/usuarios", {
      nome: "Pedro", nickname: "pedro", email: "pedro@email.com", senha: "abc",
    });
    assert.equal(res.body.status, "offline");
    assert.ok(res.body.bio.length > 0);
    assert.ok(res.body.imageProfile.startsWith("http"));
    assert.ok(res.body.imageCover.startsWith("http"));
  });

  it("aceita campos opcionais (bio, status, imagens)", async () => {
    const res = await req(app, "post", "/usuarios", {
      nome: "Maria", nickname: "maria", email: "maria@email.com", senha: "abc",
      bio: "Minha bio", status: "online", imageProfile: "https://exemplo.com/foto.jpg",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.bio, "Minha bio");
    assert.equal(res.body.status, "online");
    assert.equal(res.body.imageProfile, "https://exemplo.com/foto.jpg");
  });

  it("retorna 400 quando campos obrigatórios estão ausentes", async () => {
    const res = await req(app, "post", "/usuarios", { nome: "Incompleto" });
    assert.equal(res.status, 400);
    assert.match(res.body.erro, /nickname/);
    assert.match(res.body.erro, /email/);
    assert.match(res.body.erro, /senha/);
  });

  it("retorna 409 ao duplicar nickname", async () => {
    await req(app, "post", "/usuarios", { nome: "User A", nickname: "duplicado", email: "a@email.com", senha: "abc" });
    const res = await req(app, "post", "/usuarios", { nome: "User B", nickname: "duplicado", email: "b@email.com", senha: "abc" });
    assert.equal(res.status, 409);
    assert.match(res.body.erro, /nickname/i);
  });

  it("retorna 409 ao duplicar email", async () => {
    await req(app, "post", "/usuarios", { nome: "User C", nickname: "nick_c", email: "duplicado@email.com", senha: "abc" });
    const res = await req(app, "post", "/usuarios", { nome: "User D", nickname: "nick_d", email: "duplicado@email.com", senha: "abc" });
    assert.equal(res.status, 409);
    assert.match(res.body.erro, /e-mail/i);
  });
});

// ─── GET /usuarios ─────────────────────────────────────────────────────────

describe("GET /usuarios", () => {
  let app;

  before(() => {
    criarBancoEmMemoria();
    app = criarApp();
    criarUsuarioDB({ nome: "Alice", nickname: "alice", email: "alice@email.com", status: "online" });
    criarUsuarioDB({ nome: "Bob",   nickname: "bob",   email: "bob@email.com",   status: "offline" });
  });
  after(() => db.close());

  it("lista todos os usuários sem token (pública)", async () => {
    const res = await req(app, "get", "/usuarios");
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
  });

  it("não expõe o campo senha", async () => {
    const res = await req(app, "get", "/usuarios");
    res.body.forEach(u => assert.equal(u.senha, undefined));
  });

  it("filtra por status=online", async () => {
    const res = await req(app, "get", "/usuarios?status=online");
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].nickname, "alice");
  });

  it("retorna 400 para status de filtro inválido", async () => {
    const res = await req(app, "get", "/usuarios?status=invisivel");
    assert.equal(res.status, 400);
  });
});

// ─── GET /usuarios/:id ─────────────────────────────────────────────────────

describe("GET /usuarios/:id", () => {
  let app, id, token;

  before(() => {
    criarBancoEmMemoria();
    app = criarApp();
    id = criarUsuarioDB({ nome: "Carlos", nickname: "carlos", email: "carlos@email.com" });
    token = gerarToken(id);
  });
  after(() => db.close());

  it("retorna usuário com perfis", async () => {
    const res = await req(app, "get", `/usuarios/${id}`, undefined, token);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, id);
    assert.ok(Array.isArray(res.body.perfis));
  });

  it("retorna 404 para id inexistente", async () => {
    const res = await req(app, "get", "/usuarios/id-que-nao-existe", undefined, token);
    assert.equal(res.status, 404);
  });

  it("retorna 401 sem token", async () => {
    const res = await req(app, "get", `/usuarios/${id}`);
    assert.equal(res.status, 401);
  });
});

// ─── PUT /usuarios/:id ─────────────────────────────────────────────────────

describe("PUT /usuarios/:id", () => {
  let app, id, idOutro, token;

  before(() => {
    criarBancoEmMemoria();
    app = criarApp();
    id      = criarUsuarioDB({ nome: "Diana", nickname: "diana", email: "diana@email.com" });
    idOutro = criarUsuarioDB({ nome: "Outro", nickname: "outro", email: "outro@email.com" });
    token = gerarToken(id);
  });
  after(() => db.close());

  it("atualiza campos permitidos", async () => {
    const res = await req(app, "put", `/usuarios/${id}`, { nome: "Diana Silva", bio: "Nova bio" }, token);
    assert.equal(res.status, 200);
    assert.equal(res.body.nome, "Diana Silva");
    assert.equal(res.body.bio, "Nova bio");
  });

  it("não expõe senha na resposta", async () => {
    const res = await req(app, "put", `/usuarios/${id}`, { nome: "Diana X" }, token);
    assert.equal(res.body.senha, undefined);
  });

  it("ignora campos não permitidos (email, senha)", async () => {
    const res = await req(app, "put", `/usuarios/${id}`, { email: "novo@email.com", senha: "nova", nome: "Diana Y" }, token);
    assert.equal(res.status, 200);
    assert.notEqual(res.body.email, "novo@email.com");
  });

  it("retorna 400 quando nenhum campo editável é enviado", async () => {
    const res = await req(app, "put", `/usuarios/${id}`, { email: "x@x.com" }, token);
    assert.equal(res.status, 400);
  });

  it("retorna 409 ao tentar nickname já em uso por outro usuário", async () => {
    const res = await req(app, "put", `/usuarios/${id}`, { nickname: "outro" }, token);
    assert.equal(res.status, 409);
  });

  it("permite atualizar para o próprio nickname sem conflito", async () => {
    const res = await req(app, "put", `/usuarios/${id}`, { nickname: "diana" }, token);
    assert.equal(res.status, 200);
  });

  it("retorna 404 para id inexistente", async () => {
    const res = await req(app, "put", "/usuarios/nao-existe", { nome: "X" }, token);
    assert.equal(res.status, 404);
  });

  it("retorna 401 sem token", async () => {
    const res = await req(app, "put", `/usuarios/${id}`, { nome: "Sem Token" });
    assert.equal(res.status, 401);
  });
});

// ─── PATCH /usuarios/:id/status ────────────────────────────────────────────

describe("PATCH /usuarios/:id/status", () => {
  let app, id, token;

  before(() => {
    criarBancoEmMemoria();
    app = criarApp();
    id = criarUsuarioDB({ nome: "Eva", nickname: "eva", email: "eva@email.com" });
    token = gerarToken(id);
  });
  after(() => db.close());

  it("atualiza status para 'online'", async () => {
    const res = await req(app, "patch", `/usuarios/${id}/status`, { status: "online" }, token);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "online");
  });

  it("atualiza status para 'away'", async () => {
    const res = await req(app, "patch", `/usuarios/${id}/status`, { status: "away" }, token);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "away");
  });

  it("retorna 400 quando status não é enviado", async () => {
    const res = await req(app, "patch", `/usuarios/${id}/status`, {}, token);
    assert.equal(res.status, 400);
  });

  it("retorna 400 para status inválido", async () => {
    const res = await req(app, "patch", `/usuarios/${id}/status`, { status: "ocupado" }, token);
    assert.equal(res.status, 400);
  });

  it("retorna 404 para usuário inexistente", async () => {
    const res = await req(app, "patch", "/usuarios/nao-existe/status", { status: "online" }, token);
    assert.equal(res.status, 404);
  });

  it("retorna 401 sem token", async () => {
    const res = await req(app, "patch", `/usuarios/${id}/status`, { status: "online" });
    assert.equal(res.status, 401);
  });
});

// ─── PATCH /usuarios/:id/perfil ────────────────────────────────────────────

describe("PATCH /usuarios/:id/perfil", () => {
  let app, adminId, userId, moderadorId, tokenAdmin, tokenUser;

  before(() => {
    criarBancoEmMemoria();
    app = criarApp();
    adminId     = criarUsuarioDB({ nome: "Admin",   nickname: "admin_u",   email: "admin@email.com" });
    userId      = criarUsuarioDB({ nome: "Usuário", nickname: "usuario_u", email: "usuario@email.com" });
    moderadorId = criarUsuarioDB({ nome: "Mod",     nickname: "mod_u",     email: "mod@email.com" });
    promoverAdmin(adminId);
    tokenAdmin = gerarToken(adminId, ["administrador"]);
    tokenUser  = gerarToken(userId,  ["usuario"]);
  });
  after(() => db.close());

  it("admin pode alterar perfil de outro usuário para 'moderador'", async () => {
    const res = await req(app, "patch", `/usuarios/${userId}/perfil`, { adminId, novoPerfil: "moderador" }, tokenAdmin);
    assert.equal(res.status, 200);
    assert.ok(res.body.perfis.some(p => p.nome === "moderador"));
  });

  it("admin pode reverter perfil para 'usuario'", async () => {
    const res = await req(app, "patch", `/usuarios/${userId}/perfil`, { adminId, novoPerfil: "usuario" }, tokenAdmin);
    assert.equal(res.status, 200);
    assert.ok(res.body.perfis.some(p => p.nome === "usuario"));
  });

  it("admin pode se auto-promover (idempotente)", async () => {
    const res = await req(app, "patch", `/usuarios/${adminId}/perfil`, { adminId, novoPerfil: "administrador" }, tokenAdmin);
    assert.equal(res.status, 200);
  });

  it("não-admin recebe 403 ao tentar alterar perfil", async () => {
    const res = await req(app, "patch", `/usuarios/${adminId}/perfil`, { adminId: moderadorId, novoPerfil: "administrador" }, tokenUser);
    assert.equal(res.status, 403);
  });

  it("retorna 400 quando adminId ou novoPerfil estão ausentes", async () => {
    const res = await req(app, "patch", `/usuarios/${userId}/perfil`, { adminId }, tokenAdmin);
    assert.equal(res.status, 400);
  });

  it("retorna 404 quando adminId não existe no banco", async () => {
    const res = await req(app, "patch", `/usuarios/${userId}/perfil`, { adminId: "id-fantasma", novoPerfil: "moderador" }, tokenAdmin);
    assert.equal(res.status, 404);
  });

  it("retorna 409 para perfil inexistente", async () => {
    const res = await req(app, "patch", `/usuarios/${userId}/perfil`, { adminId, novoPerfil: "superusuario" }, tokenAdmin);
    assert.equal(res.status, 409);
  });

  it("retorna 404 para usuário alvo inexistente", async () => {
    const res = await req(app, "patch", "/usuarios/nao-existe/perfil", { adminId, novoPerfil: "moderador" }, tokenAdmin);
    assert.equal(res.status, 404);
  });

  it("retorna 401 sem token", async () => {
    const res = await req(app, "patch", `/usuarios/${userId}/perfil`, { adminId, novoPerfil: "moderador" });
    assert.equal(res.status, 401);
  });
});

// ─── DELETE /usuarios/:id ──────────────────────────────────────────────────

describe("DELETE /usuarios/:id", () => {
  let app, id, token;

  beforeEach(() => {
    criarBancoEmMemoria();
    app = criarApp();
    id = criarUsuarioDB({ nome: "Fred", nickname: "fred", email: "fred@email.com" });
    token = gerarToken(id);
  });
  after(() => db.close());

  it("remove o usuário e retorna 204", async () => {
    const res = await req(app, "delete", `/usuarios/${id}`, undefined, token);
    assert.equal(res.status, 204);
  });

  it("confirma que o usuário não existe mais após exclusão", async () => {
    await req(app, "delete", `/usuarios/${id}`, undefined, token);
    const outroToken = gerarToken("outro-qualquer-id");
    const res = await req(app, "get", `/usuarios/${id}`, undefined, outroToken);
    assert.equal(res.status, 404);
  });

  it("remove vínculos de perfil junto com o usuário (CASCADE)", async () => {
    await req(app, "delete", `/usuarios/${id}`, undefined, token);
    const vinculo = db.prepare(`SELECT 1 FROM usuario_perfil WHERE usuario_id = ?`).get(id);
    assert.equal(vinculo, undefined);
  });

  it("retorna 404 ao tentar deletar usuário inexistente", async () => {
    const res = await req(app, "delete", "/usuarios/id-que-nao-existe", undefined, token);
    assert.equal(res.status, 404);
  });

  it("retorna 401 sem token", async () => {
    const res = await req(app, "delete", `/usuarios/${id}`);
    assert.equal(res.status, 401);
  });
});
