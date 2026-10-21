import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './AuthApp';
import './style.css';
import './territory.css';
import './auth.css';
import './button-alignment.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);
