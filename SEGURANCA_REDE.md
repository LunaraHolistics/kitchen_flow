# 🔐 Kitchen Flow - Guia de Segurança e Acesso

> **Versão do Documento:** 1.1 (Compatível com Kitchen Flow v2.1.7)  
> **Última Atualização:** {{DATE}}

Este documento explica como garantir que apenas pessoas autorizadas acessem o sistema Kitchen Flow.

---

## 🎯 Objetivo

Garantir que:
- ✅ Apenas dispositivos **dentro do restaurante** acessem a página do garçom
- ✅ Apenas garçons **escalados no dia** tenham o código de acesso
- ✅ O sistema **não funcione fora do local** sem autorização
- ✅ O Painel TV exiba pedidos apenas para visualização interna

---

## 🔧 Camada 1: PIN Diário (Já Implementado)

### Como Funciona
- Um código de **4 dígitos** é necessário para acessar `waiter.html`
- O código **muda todo dia** automaticamente
- A gerente pode definir manualmente pelo menu do Bridge

### Para a Gerente Definir o PIN
1. Clique no ícone do Kitchen Flow na bandeja do Windows (perto do relógio)
2. Selecione **"🔑 Definir PIN do Garçom"**
3. Digite 4 números (ex: `2505`)
4. ✅ O sistema valida que não é repetição dos últimos 7 dias
5. ✅ O PIN aparece na tela principal do Bridge para repassar à equipe

### Para o Garçom Acessar
1. Conectar o celular na rede Wi-Fi do restaurante
2. Abrir o navegador e acessar: `http://IP-DO-PC:4545/waiter.html`
3. Digitar o PIN do dia quando solicitado
4. ✅ Acesso concedido por 24 horas

### Regras de Segurança do PIN
| Regra | Por que é importante |
|-------|---------------------|
| 4 dígitos exatos | Fácil de digitar, difícil de adivinhar |
| Não repete o PIN de ontem | Evita "preguiça mental" de reusar código |
| Não repete nenhum dos últimos 7 dias | Garante variedade e segurança básica |
| Expira à meia-noite | Garante renovação diária automática |
| Máscara na UI (**XX) | Previne que alguém veja por trás |

---

## 🔧 Camada 2: Acesso Apenas na Rede Local (Recomendado)

### Por que Configurar?
Por padrão, o Kitchen Flow escuta na porta `4545` do PC do caixa. 
**Qualquer dispositivo na mesma rede Wi-Fi pode acessar** se souber o IP e o PIN.

Para maior segurança, configure o roteador para **bloquear acesso externo**.

### Passo a Passo para Roteadores Comuns

#### 🔹 TP-Link / Intelbras / D-Link
1. Acesse o roteador: `192.168.0.1` ou `192.168.1.1` (veja no manual)
2. Vá em **Firewall** → **Controle de Acesso** ou **Regras de Porta**
3. Crie uma nova regra:

| Campo | Valor |
|-------|-------|
| Nome da Regra | Kitchen Flow - Acesso Local |
| Porta | `4545`, `4546` |
| Protocolo | `TCP` |
| Origem (Source) | **LAN** (Rede Local) |
| Destino (Destination) | IP do PC do Caixa (ex: `192.168.1.100`) |
| Ação | **PERMITIR** |

4. Crie uma segunda regra para bloquear o resto:

| Campo | Valor |
|-------|-------|
| Nome da Regra | Kitchen Flow - Bloquear Externo |
| Porta | `4545`, `4546` |
| Protocolo | `TCP` |
| Origem (Source) | **WAN** (Internet) |
| Ação | **BLOQUEAR** |

5. Salve e reinicie o roteador.

#### 🔹 Roteador com VLAN (Avançado)
Se seu roteador suportar múltiplas redes:
1. Crie uma VLAN chamada **"ADM"** para dispositivos autorizados
2. Conecte o PC do caixa e os celulares dos garçons nesta VLAN
3. Aplique as regras acima apenas para a VLAN "ADM"

---

## 📱 Como Testar a Restrição

### Teste 1: Dentro da Rede "ADM" (Deve Funcionar)
```bash
# No celular do garçom, conectado na rede do restaurante:
1. Abrir navegador
2. Acessar: http://192.168.1.100:4545/waiter.html
3. Digitar PIN do dia
4. ✅ Deve carregar a página de pedidos
```

### Teste 2: Fora da Rede (Não Deve Funcionar)
```bash
# No mesmo celular, usando 4G ou outra Wi-Fi:
1. Desconectar da rede do restaurante
2. Tentar acessar: http://192.168.1.100:4545/waiter.html
3. ❌ Deve falhar com "Não foi possível conectar" ou timeout
```

### Teste 3: PIN Expirado (Não Deve Funcionar)
```bash
# No dia seguinte, com o mesmo celular na rede:
1. Acessar waiter.html
2. Tentar usar o PIN de ontem
3. ❌ Deve mostrar: "Código expirado. Solicite o novo código à gerente."
```

---

## 📺 NOVO: Painel TV para Garçons (Kitchen Flow TV Display)

### O Que É?
Uma tela dedicada para TVs Smart do salão que exibe **todos os pedidos em tempo real**, sem necessidade de login ou PIN. Ideal para:
- Garçons visualizarem pedidos prontos sem ir à cozinha
- Evitar que a equipe fique olhando o celular na frente dos clientes
- Aumentar a agilidade na retirada de pedidos

### 🔐 Segurança do Painel TV
| Característica | Descrição |
|---------------|-----------|
| **Apenas leitura** | Não permite editar, cancelar ou iniciar pedidos |
| **Sem autenticação** | Acesso aberto na rede local (como o tablet da cozinha) |
| **Sem dados sensíveis** | Exibe apenas mesa, itens e tempo — sem valores ou dados de cliente |
| **Restrito à rede local** | Só acessível via `http://IP-DO-PC:4545/tv-display.html` |

### Como Configurar na TV Smart

#### Passo 1: Descobrir o IP do PC do Caixa
No PC do caixa, abra o Prompt de Comando e digite:
```cmd
ipconfig
```
Anote o **Endereço IPv4** (ex: `192.168.0.190`).

#### Passo 2: Acessar na TV
1.  Na TV Smart, abra o **navegador de internet** (Chrome, Samsung Internet, etc.)
2.  Digite na barra de endereços:
    ```
    http://192.168.0.190:4545/tv-display.html
    ```
    *(Substitua pelo IP real do seu PC)*
3.  Na primeira vez, a tela pedirá para confirmar o IP. Digite e clique em **"Conectar"**.
4.  ✅ A tela dividida aparecerá: **🔥 Em Produção** (esquerda) e **✅ Prontos** (direita).

#### Passo 3: Opcional - Fixar como "App" na TV
Algumas TVs permitem "Adicionar à tela inicial" ou "Criar atalho". Se disponível:
1.  No navegador da TV, acesse o menu (⋮ ou ⚙️)
2.  Selecione **"Adicionar à tela inicial"** ou **"Criar atalho"**
3.  Nomeie como "Kitchen Flow TV"
4.  ✅ Agora o ícone aparecerá no menu da TV para acesso rápido

### Como Funciona o Alerta de Pedido Pronto

1.  **Quando a cozinha marca um pedido como "Pronto"** no tablet:
    - 🔔 A TV emite um **bip discreto** (som de sineta suave)
    - 💚 O card do pedido **pisca em verde** na coluna "Prontos"
    - 📋 O pedido aparece no **topo da lista** (mais recente primeiro)

2.  **O garçom no salão**:
    - Vê o card piscando ou ouve o bip
    - Identifica a **Mesa XX** e os **itens**
    - Vai à boqueta retirar o pedido

3.  **O card permanece destacado** até:
    - O próximo pedido pronto entrar (rolagem automática)
    - Ou a TV ser recarregada (F5)

### Posicionamento Recomendado da TV

| Local | Vantagem | Cuidado |
|-------|----------|---------|
| **Perto da boqueta** | Garçom vê ao passar para retirar | Não atrapalhar fluxo da cozinha |
| **No centro do salão** | Todos os garçons enxergam | Evitar reflexo de luz ou sol |
| **Acima do balcão** | Visível de longe | Garantir que altura permita leitura |

> 💡 **Dica**: Use fundo escuro da TV para não ofuscar o ambiente e ajustar brilho para 60-70%.

### Solução de Problemas Comuns

| Problema | Causa Provável | Solução |
|----------|---------------|---------|
| **Tela não carrega** | IP errado ou Bridge desligado | Verificar `ipconfig` no PC e se o ícone 🍳 está na bandeja |
| **Sem som de alerta** | TV no mudo ou volume baixo | Ajustar volume da TV; o som é gerado via Web Audio API |
| **Card não pisca** | Navegador da TV com limitações | Atualizar navegador da TV ou usar Chromecast/Fire Stick |
| **Pedidos não atualizam** | Conexão Wi-Fi instável | Verificar sinal da TV; aproximar do roteador se necessário |
| **Tela pede IP toda vez** | Cache do navegador limpo | Usar URL com parâmetro: `?ip=192.168.0.190` para fixar |

### URL com IP Fixo (Opcional)
Para evitar digitar o IP toda vez, use esta URL no navegador da TV:
```
http://192.168.0.190:4545/tv-display.html?ip=192.168.0.190
```
*(Substitua `192.168.0.190` pelo IP real do seu PC)*

---

## 🔄 Rotina Diária Recomendada

### Para a Gerente (Início do Turno)
```
[ ] 1. Verificar se o Bridge está rodando no PC do caixa (ícone na bandeja)
[ ] 2. Definir o PIN do dia (ou confirmar que foi gerado automaticamente)
[ ] 3. Anotar o PIN em local seguro ou repassar verbalmente à equipe
[ ] 4. Informar aos garçons escalados: "PIN de hoje: XXXX"
[ ] 5. Testar rapidamente: abrir waiter.html e validar acesso
[ ] 6. Verificar se a TV do salão está ligada e exibindo o Painel TV
```

### Para os Garçons (Durante o Turno)
```
[ ] 1. Conectar celular na rede Wi-Fi do restaurante
[ ] 2. Acessar waiter.html e digitar o PIN (ou abrir o app PWA instalado)
[ ] 3. Ativar notificações quando solicitado (para vibração/som de pedidos prontos)
[ ] 4. Usar filtro "Só meus" para ver apenas seus pedidos (opcional)
[ ] 5. Observar a TV do salão para identificar pedidos prontos visualmente
[ ] 6. Ao final do turno, fechar o app ou fazer logout (se implementado)
```

### Para a Cozinha (Durante o Turno)
```
[ ] 1. Manter o tablet da cozinha conectado e visível
[ ] 2. Marcar itens como "Pronto" assim que finalizados
[ ] 3. Observar se os alertas estão chegando na TV do salão
[ ] 4. Comunicar à gerência se a TV travar ou não atualizar
```

### Para o Suporte Técnico (Manutenção Semanal)
```
[ ] 1. Verificar logs do Bridge em %APPDATA%\KitchenFlow\logs\
[ ] 2. Confirmar que pin-state.json e pin-history.json estão sendo atualizados
[ ] 3. Testar acesso da TV e do waiter de dentro e fora da rede periodicamente
[ ] 4. Atualizar este documento se houver mudanças na infraestrutura
[ ] 5. Verificar se há atualizações do sistema Kitchen Flow disponíveis
```

---

## 🚨 O Que Fazer Se um Ex-Funcionário Tentar Acessar

| Cenário | O Que Acontece | Ação Recomendada |
|---------|---------------|-----------------|
| **Fora da rede local** | Não consegue conectar (roteador bloqueia) | Nenhuma ação necessária |
| **Dentro da rede mas sem PIN** | Vê tela de bloqueio com instruções | Nenhuma ação necessária |
| **Com PIN antigo** | Vê "Código expirado" | Nenhuma ação necessária |
| **Com PIN atual mas não escalado** | Vê pedidos de todos os garçons | Orientar a usar filtro "Só meus" ou remover acesso à rede |
| **Acessando a TV do salão** | Vê todos os pedidos (somente leitura) | Garantir que a TV esteja em área restrita à equipe |

> 💡 **Dica de Segurança:** Se um garçom sair da equipe, basta **não repassar o novo PIN do dia** para ele. O PIN antigo expira automaticamente à meia-noite, revogando o acesso sem necessidade de reconfiguração técnica.

---

## 📞 Suporte e Contato

Dúvidas na configuração, problemas de acesso ou solicitação de novas funcionalidades?

### Contato Técnico
- **WhatsApp:** (16) 99793-4558
- **Email:** suporte@kitchenflow.com.br
- **Horário de Atendimento:** Seg-Sex, 8h-18h

### Ao Entrar em Contato, Informe:
```
📍 Local: [Nome do Restaurante]
📱 Dispositivo: [Celular/Tablet/TV/PC]
🔗 Rede: [Nome da Wi-Fi ou "4G"]
🔑 PIN: [Apenas os 2 últimos dígitos, ex: **05]
🕐 Horário do erro: [HH:MM]
📋 Mensagem de erro: [Copiar e colar ou print]
🔄 Ação realizada: [O que tentou fazer antes do erro]
```

### Tempo Médio de Resposta
- 🟢 Crítico (sistema fora do ar): Até 2 horas
- 🟡 Importante (funcionalidade limitada): Até 24 horas
- 🔵 Dúvida/Consulta: Até 48 horas

---

## 📎 Anexos Técnicos

### Como Descobrir o IP do PC do Caixa
Para configurar o acesso ou solucionar problemas de conexão:

1. No PC do caixa, abra o **Prompt de Comando**:
   - Pressione `Windows + R`
   - Digite `cmd` e pressione Enter

2. No terminal preto, digite:
   ```
   ipconfig
   ```

3. Procure por **"Endereço IPv4"** em:
   - "Adaptador Wi-Fi" (se conectado sem fio) OU
   - "Adaptador Ethernet" (se conectado por cabo)

4. Anote o número (ex: `192.168.1.100`)

> 🔒 **Importante:** Este IP pode mudar se o roteador reiniciar. Para IP fixo, configure reserva de DHCP no roteador.

### Como Instalar como PWA (App Nativo) no Celular

#### Android (Google Chrome)
1. Acessar `http://IP-DO-PC:4545/waiter.html`
2. Tocar no menu **⋮** (três pontos no canto superior direito)
3. Selecionar **"Adicionar à tela inicial"** ou **"Instalar aplicativo"**
4. Confirmar o nome "KF Garçom"
5. ✅ Ícone aparecerá na tela inicial como um app nativo

#### iOS (Apple Safari)
1. Acessar `http://IP-DO-PC:4545/waiter.html`
2. Tocar no botão de **Compartilhar** (quadrado com seta para cima)
3. Rolar para baixo e selecionar **"Adicionar à Tela de Início"**
4. Confirmar o nome "KF Garçom"
5. ✅ Ícone aparecerá na tela inicial como um app nativo

> ⚠️ **Nota Técnica:** O PWA só funciona em conexões seguras (HTTPS) ou localhost. 
> Para produção em larga escala, considere configurar um certificado SSL no Bridge.

### Como Configurar a TV Smart para o Painel

#### Samsung Tizen (2018+)
1. Abrir app **Internet** (navegador)
2. Digitar: `http://IP-DO-PC:4545/tv-display.html`
3. Se pedir, permitir "Acesso a dispositivos locais"
4. Para fixar: Menu ⋮ → "Adicionar à Home"

#### LG webOS (2019+)
1. Abrir app **Web Browser**
2. Digitar a URL do Painel TV
3. Para criar atalho: Menu ⚙️ → "Adicionar à Página Inicial"

#### Android TV / Google TV
1. Abrir app **Chrome** ou **Browser**
2. Acessar a URL do Painel TV
3. Para fixar: Menu ⋮ → "Adicionar à tela inicial"

#### Fire TV Stick (Amazon)
1. Instalar o app **Silk Browser** ou **Firefox** pela loja
2. Acessar a URL do Painel TV
3. Para facilitar: Criar um atalho na tela inicial via app "Downloader"

> 💡 **Dica:** Se o navegador da TV for lento, considere usar um **Chromecast** ou **Fire Stick** espelhando a aba do navegador do PC.

### Solução de Problemas Comuns

| Problema | Possível Causa | Solução |
|----------|---------------|---------|
| "Não foi possível conectar" | IP do PC mudou ou roteador bloqueou | Verificar IP com `ipconfig` e regras do firewall |
| "PIN inválido" | Código digitado errado ou expirado | Confirmar PIN atual com a gerente |
| App não notifica pedidos | Permissão de notificação negada | Reinstalar PWA e aceitar permissões |
| Pedidos não atualizam | Cache offline ativo ou rede instável | Puxar para atualizar (pull-to-refresh) ou verificar conexão |
| Tela branca/carregando infinito | Service Worker com erro | Limpar cache do navegador e recarregar |
| TV não toca o bip de alerta | Navegador da TV bloqueia Web Audio API | Usar Chromecast/Fire Stick ou ajustar configurações de som |
| Card não pisca na TV | CSS de animação não suportado | Atualizar firmware da TV ou usar dispositivo externo |

---

## 📄 Informações Legais

- **Propriedade:** Kitchen Flow é uma solução desenvolvida por CLB Studio - Celso Luiz.
- **Licença de Uso:** O acesso ao sistema está condicionado à licença ativa.
- **Privacidade:** Os dados de pedidos são processados localmente e não são compartilhados com terceiros sem consentimento.
- **Atualizações:** Novas versões do sistema podem ser entregues remotamente via Bridge.

---

*Documento gerado automaticamente pelo sistema Kitchen Flow.*  
*CLB Studio - Desenvolvimento de Soluções para Restaurantes*  
*© 2026 Todos os direitos reservados.*