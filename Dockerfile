FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache su-exec
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY group-photos.js interface.js server.js rotation.js rotation-persistence.js global-cycle.js image-upload.js waha-groups.js waha-settings.js dispatch.js shell.css themes.css ui-themes.js upload-ui.js waha-connections.js login-auth.js login-page.js login.css brand-settings.js click-tracking.js sidebar-nav.js ./
RUN mkdir -p /data/products /data/secrets && chown -R node:node /data/products /data/secrets
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "chown node:node /data/products /data/secrets && exec su-exec node node server.js"]


