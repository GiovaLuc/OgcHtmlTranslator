FROM node:18

WORKDIR /app

# Copy package.json first
COPY package.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of your files
COPY . .

EXPOSE 3001

CMD ["node", "translator.js"]
