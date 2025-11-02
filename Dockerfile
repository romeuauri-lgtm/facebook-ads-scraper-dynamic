# Usa imagem base com Node + Playwright já preparado
FROM apify/actor-node-playwright:latest

# Define diretório de trabalho dentro do container
WORKDIR /usr/src/app

# Copia os arquivos do projeto para dentro do container
COPY . ./

# Instala dependências do package.json
RUN npm install --omit=dev

# Instala navegadores e dependências do Playwright (essencial!)
RUN npx playwright install --with-deps

# Define comando padrão de execução
CMD ["npm", "start"]
