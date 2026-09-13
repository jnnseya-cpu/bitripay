import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { StoreProvider } from './lib/store';
import { App } from './App';
import './theme.css';
import { registerPwa } from './lib/pwa';

registerPwa();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <StoreProvider>
        <App />
      </StoreProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
