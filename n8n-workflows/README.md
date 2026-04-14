# n8n Workflow Setup

## Cach import workflow vao n8n

1. Mo n8n tai http://localhost:5678
2. Click "Import from file"
3. Chon file `fb-post-workflow.json`

## Workflow: Telegram -> n8n -> Facebook

### Node 1: Telegram Trigger
- Type: Telegram Trigger
- Event: message
- Bot Token: (lay tu BotFather)

### Node 2: IF - Phan loai lenh
- Dieu kien: kiem tra message bat dau bang /post_page, /post_group, /post_personal

### Node 3: HTTP Request - Goi webhook
- Method: POST
- URL: http://localhost:3000/webhook/fb-post
- Body (JSON):
```json
{
  "target": "page",
  "message": "{{ $json.message.text }}"
}
```

### Node 4: Telegram - Tra ket qua
- Type: Telegram
- Action: Send Message
- Chat ID: {{ $json.message.chat.id }}
- Text: Ket qua dang bai

## Luu y
- Dam bao server (npm start) dang chay truoc khi su dung n8n workflow
- Hoac dung truc tiep Telegram bot (npm run bot) ma khong can n8n
