// src/app.js
import express from 'express'
import config from './config.js';
import cors from 'cors';

const app = express();

app.use(express.json());
app.use(cors(config.cors));

app.get('/', (req, res) => {
  res.status(200).json({
    message: 'OK'
  })
})

export default app;
