# Usa imagem base com Node + Playwright já configurado
FROM apify/actor-node-playwright:latest

# Define diretório de trabalho dentro do container
WORKDIR /usr/src/app

# Copia os arquivos do projeto
COPY . ./

# Corrige permissões antes da instalação
USER root
RUN mkdir -p /usr/src/app/node_modules && chown -R root:root /usr/src/app

# Instala dependências
RUN npm install --omit=dev

# Instala navegadores Playwright (Chromium, Firefox, WebKit)
RUN npx playwright install --with-deps

# Retorna para o usuário padrão da Apify (segurança)
USER myuser

# Define comando padrão
CMD ["npm", "start"]
