# Contributing to Vero Relayer Service

## Environment Setup

1. **Node.js Version**
   This project uses a locked Node.js runtime version to ensure environment consistency. We recommend using [nvm](https://github.com/nvm-sh/nvm) (Node Version Manager).
   
   To switch to the correct version, simply run:
   ```bash
   nvm use
   ```

2. **Environment Variables**
   The project requires certain environment variables to be set. We provide a `.env.example` file as a blueprint.
   
   Copy the example file to `.env`:
   ```bash
   cp .env.example .env
   ```
   Then open `.env` in your editor and configure the variables with your local secrets. Do NOT commit the `.env` file containing real secrets to the repository.
