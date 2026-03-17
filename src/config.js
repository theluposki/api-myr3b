// src/config.js
export default {
  app: {
    port: process.env.PORT || 3000,
  },
  cors: {
    origin: process.env.CORS_ORIGIN || '*',  // restrinja em produção!
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  }
}
