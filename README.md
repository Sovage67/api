# Bot Intrépides — API Backend

API REST (Fastify) du projet Bot Intrépides. Gère l'authentification OAuth2 Discord, la configuration des serveurs, et la communication vers le bot via Redis Pub/Sub.

## Démarrage local

```bash
cp .env.example .env
# Remplis .env (Discord OAuth, Supabase, Upstash Redis)

npm install
npx prisma generate
npx prisma migrate deploy

npm run dev
```

L'API tourne sur `http://localhost:3001`.

## Routes principales

| Méthode | Route | Description |
|---|---|---|
| GET | `/health` | Health check (UptimeRobot) |
| GET | `/api/auth/login` | Redirige vers Discord OAuth2 |
| GET | `/api/auth/callback` | Callback OAuth2 |
| POST | `/api/auth/logout` | Déconnexion |
| GET | `/api/user/me` | Profil + serveurs admin |
| GET | `/api/guilds/:id` | Config d'un serveur |
| PATCH | `/api/guilds/:id` | Modifier la config |
| GET | `/api/guilds/:id/warns` | Liste des warns |
| POST | `/api/stripe/webhook` | Webhook Stripe (premium) |

## Déploiement sur Render

1. Push ce repo sur GitHub
2. Sur Render → New Web Service → connecte le repo
3. Configuration :
   - Build command : `npm install && npm run build`
   - Start command : `npm start`
   - Health check path : `/health`
4. Variables d'environnement : copie celles de `.env.example`
5. Configure UptimeRobot pour ping `https://[ton-api].onrender.com/health`

Voir le `DEPLOYMENT.md` à la racine du projet pour le guide complet.

## Sécurité

- Toutes les routes `/api/guilds/*` vérifient que l'utilisateur connecté a bien la permission ADMINISTRATOR sur la guilde
- Rate limit : 100 req/min par IP
- Cookies de session signés (JWT, HttpOnly, SameSite=Lax, Secure en prod)
- Validation Zod sur tous les bodies de requêtes mutantes

## Communication avec le bot

Quand le dashboard modifie la config d'un serveur, l'API publie un événement sur le canal Redis `guild:update`. Le bot, abonné à ce canal, invalide son cache local et applique le changement instantanément.
