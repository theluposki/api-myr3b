import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("app.db");

// ─── Pragmas ───────────────────────────────────────────────────────────────
db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);

// ─── Schema ────────────────────────────────────────────────────────────────
db.exec(`
  -- Tabela perfis
  CREATE TABLE IF NOT EXISTS perfis (
    id   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
    nome TEXT NOT NULL UNIQUE CHECK (nome IN ('administrador', 'moderador', 'usuario'))
  );

  -- Seed: perfis padrão
  INSERT OR IGNORE INTO perfis (nome) VALUES ('administrador'), ('moderador'), ('usuario');

  -- Tabela usuarios
  CREATE TABLE IF NOT EXISTS usuarios (
    id             TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
    nome           TEXT    NOT NULL,
    nickname       TEXT    NOT NULL UNIQUE,
    email          TEXT    NOT NULL UNIQUE,
    senha          TEXT    NOT NULL,
    imageProfile   TEXT    NOT NULL DEFAULT 'https://ui-avatars.com/api/?background=random',
    imageCover     TEXT    NOT NULL DEFAULT 'https://placehold.co/1200x300/1a1a2e/white',
    bio            TEXT    NOT NULL DEFAULT 'Olá! Estou usando este app.',
    status         TEXT    NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'away', 'busy')),
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );

  -- Trigger: atualiza updated_at automaticamente
  CREATE TRIGGER IF NOT EXISTS trg_usuarios_updated_at
  AFTER UPDATE ON usuarios
  FOR EACH ROW
  BEGIN
    UPDATE usuarios SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = OLD.id;
  END;

  -- Tabela usuario_perfil
  CREATE TABLE IF NOT EXISTS usuario_perfil (
    usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    perfil_id  TEXT NOT NULL REFERENCES perfis(id)   ON DELETE RESTRICT,
    PRIMARY KEY (usuario_id, perfil_id)
  );
`);

// ─── Helpers internos ──────────────────────────────────────────────────────

/** Retorna o id do perfil pelo nome */
function getPerfilId(nome) {
  return db.prepare(`SELECT id FROM perfis WHERE nome = ?`).get(nome)?.id;
}

/** Verifica se um usuário tem determinado perfil */
function usuarioTemPerfil(usuarioId, nomePerfil) {
  const perfilId = getPerfilId(nomePerfil);
  return !!db
    .prepare(`SELECT 1 FROM usuario_perfil WHERE usuario_id = ? AND perfil_id = ?`)
    .get(usuarioId, perfilId);
}

// ─── API pública ───────────────────────────────────────────────────────────

/**
 * Cria um novo usuário.
 * - Perfil padrão: "usuario"
 * - Verifica duplicatas de nickname e email com mensagens distintas
 *
 * @param {{ nome, nickname, email, senhaHash, imageProfile?, imageCover?, bio?, status? }} dados
 * @returns {{ id: string }} ID do novo usuário
 */
export function criarUsuario({ nome, nickname, email, senhaHash, imageProfile, imageCover, bio, status }) {
  // Verificar duplicatas explicitamente para mensagens claras
  if (db.prepare(`SELECT 1 FROM usuarios WHERE nickname = ?`).get(nickname)) {
    throw new Error(`Nickname "${nickname}" já está em uso.`);
  }
  if (db.prepare(`SELECT 1 FROM usuarios WHERE email = ?`).get(email)) {
    throw new Error(`E-mail "${email}" já está cadastrado.`);
  }

  const insert = db.prepare(`
    INSERT INTO usuarios (nome, nickname, email, senha, imageProfile, imageCover, bio, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const perfilUsuarioId = getPerfilId("usuario");

  const criarComPerfil = db.transaction(() => {
    insert.run(
      nome,
      nickname,
      email,
      senhaHash,
      imageProfile  ?? undefined,   // usa DEFAULT se undefined
      imageCover    ?? undefined,
      bio           ?? undefined,
      status        ?? undefined
    );

    const { id } = db.prepare(`SELECT id FROM usuarios WHERE email = ?`).get(email);

    db.prepare(`INSERT INTO usuario_perfil (usuario_id, perfil_id) VALUES (?, ?)`).run(id, perfilUsuarioId);

    return id;
  });

  const id = criarComPerfil();
  return { id };
}

/**
 * Busca um usuário pelo ID (sem retornar a senha).
 */
export function buscarUsuarioPorId(id) {
  return db.prepare(`
    SELECT id, nome, nickname, email, imageProfile, imageCover, bio, status, created_at, updated_at
    FROM usuarios WHERE id = ?
  `).get(id) ?? null;
}

/**
 * Lista os perfis de um usuário.
 */
export function listarPerfisDoUsuario(usuarioId) {
  return db.prepare(`
    SELECT p.id, p.nome
    FROM perfis p
    JOIN usuario_perfil up ON up.perfil_id = p.id
    WHERE up.usuario_id = ?
  `).all(usuarioId);
}

/**
 * Atualiza o perfil de um usuário.
 * Apenas administradores podem executar esta ação.
 *
 * @param {{ adminId, targetUsuarioId, novoPerfil }} params
 */
export function alterarPerfil({ adminId, targetUsuarioId, novoPerfil }) {
  if (!usuarioTemPerfil(adminId, "administrador")) {
    throw new Error("Apenas administradores podem alterar perfis.");
  }

  const perfilId = getPerfilId(novoPerfil);
  if (!perfilId) {
    throw new Error(`Perfil "${novoPerfil}" não existe.`);
  }

  db.transaction(() => {
    db.prepare(`DELETE FROM usuario_perfil WHERE usuario_id = ?`).run(targetUsuarioId);
    db.prepare(`INSERT INTO usuario_perfil (usuario_id, perfil_id) VALUES (?, ?)`).run(targetUsuarioId, perfilId);
  })();
}

/**
 * Atualiza campos editáveis do usuário (exceto senha, email e perfil).
 */
export function atualizarUsuario(id, campos) {
  const permitidos = ["nome", "nickname", "imageProfile", "imageCover", "bio", "status"];
  const entradas = Object.entries(campos).filter(([k]) => permitidos.includes(k));

  if (entradas.length === 0) throw new Error("Nenhum campo válido para atualizar.");

  if (campos.nickname) {
    const existente = db.prepare(`SELECT id FROM usuarios WHERE nickname = ?`).get(campos.nickname);
    if (existente && existente.id !== id) throw new Error(`Nickname "${campos.nickname}" já está em uso.`);
  }

  const sets = entradas.map(([k]) => `${k} = ?`).join(", ");
  const valores = entradas.map(([, v]) => v);

  db.prepare(`UPDATE usuarios SET ${sets} WHERE id = ?`).run(...valores, id);
}

/**
 * Atualiza o status do usuário.
 */
export function atualizarStatus(id, status) {
  const validos = ["online", "offline", "away", "busy"];
  if (!validos.includes(status)) throw new Error(`Status inválido: ${status}`);
  db.prepare(`UPDATE usuarios SET status = ? WHERE id = ?`).run(status, id);
}

export { db };
