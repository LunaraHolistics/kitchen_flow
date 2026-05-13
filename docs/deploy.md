# 🚀 Guia de Deploy - Kitchen Flow Monitor v2

## Links Atuais
- **Frontend (Vercel)**: https://kitchen-flow-frontend.vercel.app
- **Backend (Render)**: https://kitchen-flow-swq2.onrender.com

## Backend - Render

### Configuração
1. Root Directory: `backend`
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Environment Variables:
NODE_ENV=production
STORAGE_TYPE=json
MAX_ORDERS=500
FRONTEND_URL=https://kitchen-flow-frontend.vercel.app

### Health Check
Acesse: `https://kitchen-flow-swq2.onrender.com/health`

## Frontend - Vercel

### Configuração
1. Root Directory: `frontend`
2. Framework Preset: Other
3. Build Command: `npm run build`
4. Output Directory: `.`
5. Environment Variables:
VITE_BACKEND_URL=https://kitchen-flow-swq2.onrender.com

### Testar
Acesse no tablet: https://kitchen-flow-frontend.vercel.app

## Electron Bridge - PC Restaurante

### Build do .exe
```bash
cd electron-bridge
npm install
npm run build
# Saída: dist/Kitchen Flow Bridge Setup.exe

Configuração (.env)
KFM_BACKEND_URL=https://kitchen-flow-swq2.onrender.com
KFM_DOWNLOAD_PATH=C:\downloads
# Opcional: KFM_API_KEY=sua-chave

Instalação
Copie o .exe para o PC do restaurante
Execute o instalador
O app aparecerá na bandeja do sistema
Teste Rápido
Crie arquivo: C:\downloads\teste.saiposnfeprt
Aguarde ~2 segundos
Verifique no tablet se o pedido apareceu

ATUALIZAÇÕES:
# Após alterar código:
git add .
git commit -m "feat: descrição"
git push origin main

# Render e Vercel fazem deploy automático
# Electron: rebuild e copie novo .exe

Troubleshooting
Problema              Solução     
Tablet offline        Verifique URL no ⚙️ do frontend
Pedidos não chegam    Confira logs no dashboard do Render
Electron não detecta  Confirme pasta C:\downloads existe
Erro 401              Configure ELECTRON_API_KEY igual em backend e .env

Segurança
Use ELECTRON_API_KEY para autenticar requisições do Electron
Configure FRONTEND_URL no backend para restringir CORS
Ambos os serviços usam HTTPS automaticamente