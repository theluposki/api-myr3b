import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("Variável de ambiente JWT_SECRET não definida.");
}

/**
 * Middleware de autenticação via JWT.
 *
 * Espera o header:
 *   Authorization: Bearer <token>
 *
 * Em caso de sucesso, injeta em req.usuario:
 *   { id, email, perfis }
 */
export function autenticar(req, res, next) {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ erro: "Token não fornecido." });
  }

  const token = authHeader.slice(7); // remove "Bearer "

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.usuario = payload; // { id, email, perfis }
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ erro: "Token expirado." });
    }
    return res.status(401).json({ erro: "Token inválido." });
  }
}
