const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { put, del } = require('@vercel/blob'); // NOVO: SDK do Vercel Blob
require('dotenv').config(); 
const db = require('./conexao');

const app = express();
const PORT = process.env.PORT || 3000; 

app.use(cors());

// Configura o body-parser para JSON e permite payloads grandes 
app.use(bodyParser.json({ limit: '50mb' }));


// --- FUNÇÃO AUXILIAR DE UPLOAD DE BASE64 PARA VERCEL BLOB ---
const uploadBase64ToStorage = async (dataUrl) => {
    if (!dataUrl || !dataUrl.startsWith('data:')) {
        throw new Error("Formato de Base64 inválido.");
    }

    const parts = dataUrl.split(';base64,');
    if (parts.length !== 2) {
        throw new Error("Base64 malformado.");
    }
    const mimeType = parts[0].split(':')[1];
    const base64Data = parts[1];
    const fileBuffer = Buffer.from(base64Data, 'base64');
    
    // Nomes de variáveis 
    const extensaoMapeada = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'application/pdf': 'pdf',
        'image/svg+xml': 'svg',
    };
    const extensao = extensaoMapeada[mimeType] || 'bin';
    
    // Gera nome de arquivo único (chave única no Vercel Blob)
    const NomeArquivo = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${extensao}`;

    // Salva no Vercel Blob
    const resultado = await put(NomeArquivo, fileBuffer, {
        access: 'public', // Permite acesso público via URL
        contentType: mimeType // Define o tipo de conteúdo
    });

    // Retorna a URL pública gerada pelo Vercel Blob
    return resultado.url;
};


// --- ROTA 1: LISTAR PRODUTOS (GET /produtos) ---
app.get('/produtos', async (req, res) => {
    try {
        const query = 'SELECT id, nome, imagem_url, pdf_url, youtube_link FROM produtos ORDER BY id DESC';
        const resultados = await db.query(query);
        
        // Mapeia o formato do DB para o formato do Frontend
        const resultadosFormatados = resultados.rows.map(resultado => ({
            id: resultado.id,
            name: resultado.nome,
            image: resultado.imagem_url, 
            pdfDataUrl: resultado.pdf_url, 
            youtubeLink: resultado.youtube_link,
        }));
        
        res.json(resultadosFormatados);
    } catch (err) {
        console.error('Erro ao consultar o banco de dados:', err);
        res.status(500).json({ error: 'Erro interno ao consultar o catálogo.' });
    }
});

// --- ROTA 2: CADASTRAR PRODUTO (POST /produtos) ---
app.post('/produtos', async (req, res) => {
    // Nomes de variáveis em português adotados (nome, imagem)
    const { nome, imagem, pdfDataUrl, youtubeLink } = req.body;

    if (!nome || !imagem || !pdfDataUrl || !youtubeLink) {
        return res.status(400).json({ error: "Todos os campos (nome, imagem, pdf, link) são obrigatórios." });
    }

    let finalImageUrl, finalPdfUrl;

    try {
        // 1. Processar e salvar arquivos Base64 no Vercel Blob
        finalImageUrl = await uploadBase64ToStorage(imagem);
        finalPdfUrl = await uploadBase64ToStorage(pdfDataUrl);

        // 2. Inserir metadados e URLs públicas no PostgreSQL
        const query = `
            INSERT INTO produtos (nome, imagem_url, pdf_url, youtube_link) 
            VALUES ($1, $2, $3, $4) 
            RETURNING id, nome, imagem_url, pdf_url, youtube_link;
        `;
        const values = [nome, finalImageUrl, finalPdfUrl, youtubeLink];
        
        const resultado = await db.query(query, values);
        const novoProduto = resultado.rows[0];

        const ProdutoFormatado = {
            id: novoProduto.id,
            name: novoProduto.nome,
            image: novoProduto.imagem_url,
            pdfDataUrl: novoProduto.pdf_url,
            youtubeLink: novoProduto.youtube_link,
        };
        
        return res.status(201).json(ProdutoFormatado);

    } catch (err) {
        console.error('Erro no cadastro ou upload:', err);
        res.status(500).json({ error: 'Erro ao cadastrar produto. Verifique o formato dos arquivos e a configuração do Vercel Blob.' });
    }
});

// --- ROTA 3: EXCLUIR PRODUTO (DELETE /produtos/:id) ---
app.delete('/produtos/:id', async (req, res) => {
    // Nome de variável em português adotado
    const id_produto = parseInt(req.params.id);

    try {
        // 1. Buscar o produto para obter as URLs dos arquivos
        const selectQuery = 'SELECT imagem_url, pdf_url FROM produtos WHERE id = $1';
        const resultado = await db.query(selectQuery, [id_produto]);

        if (resultado.rowCount === 0) {
            return res.status(404).json({ error: 'Produto não encontrado.' });
        }

        const { imagem_url, pdf_url } = resultado.rows[0];

        // 2. Excluir a entrada do banco de dados
        const deleteQuery = 'DELETE FROM produtos WHERE id = $1';
        await db.query(deleteQuery, [id_produto]);

        // 3. Excluir arquivos do Vercel Blob usando a URL completa
        const urlsToDelete = [imagem_url, pdf_url].filter(url => url && url.startsWith('http'));
        
        for (const url of urlsToDelete) {
            try {
                // O Vercel Blob aceita a URL completa para exclusão
                await del(url); 
            } catch (fileErr) {
                // Avisa, mas continua, pois o registro do DB já foi excluído
                console.warn(`Aviso: Não foi possível deletar o arquivo Vercel Blob: ${url}.`, fileErr.message);
            }
        }
        
        res.status(200).json({ message: `Produto ${id_produto} excluído com sucesso.` });

    } catch (err) {
        console.error('Erro na exclusão do produto:', err);
        res.status(500).json({ error: 'Erro interno ao excluir produto.' });
    }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(PORT, () => {
    console.log(`\nServidor Express rodando em http://localhost:${PORT}`);
});
