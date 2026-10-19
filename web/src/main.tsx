import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';
import './week.css';
import './auth.css';
import './button-alignment.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);
