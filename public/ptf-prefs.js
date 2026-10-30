// Общие настройки экрана для всех мини-приложений: тема и язык.
//
// Тема хранится на устройстве (ptf_theme) — так было и раньше в лиге и матчах.
// Язык хранится на устройстве (ptf_lang) и дополнительно уходит на сервер в
// анкету игрока: тогда и бот, и тексты ошибок сервера говорят на том же языке.
//
// Кто главнее при открытии экрана:
//   1) язык из анкеты (сервер говорит lang_source: 'profile') — его выбрали
//      сознательно, в боте или этим же переключателем;
//   2) выбор на этом устройстве — для тех, у кого анкеты ещё нет;
//   3) язык Telegram.
(function(w,d){
  var TK='ptf_theme',LK='ptf_lang';
  var BG={dark:'#0A0A0B',light:'#F2F5F1'};
  var tg=w.Telegram&&w.Telegram.WebApp;
  function get(k){try{return w.localStorage.getItem(k)||''}catch(e){return ''}}
  function put(k,v){try{w.localStorage.setItem(k,v)}catch(e){}}
  function tgLang(){
    // В браузере (сайт) Telegram языка не знает — берём язык браузера.
    var code=(tg&&tg.initDataUnsafe&&tg.initDataUnsafe.user&&tg.initDataUnsafe.user.language_code)||(w.navigator&&(w.navigator.language||''))||'';
    return String(code).toLowerCase().indexOf('ru')===0?'ru':'en';
  }
  function savedLang(){var v=get(LK);return v==='ru'||v==='en'?v:''}

  var theme=get(TK)==='light'?'light':'dark';
  // ?lang=ru|en в адресе (ссылки из поиска на русскую/английскую версию)
  // главнее всего остального и запоминается на устройстве.
  var urlLang='';try{urlLang=(new URLSearchParams(w.location.search).get('lang')||'').toLowerCase()}catch(e){}
  if(urlLang==='ru'||urlLang==='en')put(LK,urlLang);
  var lang=savedLang()||tgLang();
  var mounts=[];

  function paintTheme(){
    d.documentElement.setAttribute('data-theme',theme);
    try{if(tg&&tg.setHeaderColor)tg.setHeaderColor(BG[theme])}catch(e){}
    try{if(tg&&tg.setBackgroundColor)tg.setBackgroundColor(BG[theme])}catch(e){}
  }
  // Сразу при подключении: страница не мигает тёмной перед светлой.
  paintTheme();

  function setTheme(v){theme=v==='light'?'light':'dark';put(TK,theme);paintTheme();sync()}
  function resolveLang(j){
    j=j||{};
    var s=j.lang==='ru'||j.lang==='en'?j.lang:'';
    if(s&&j.lang_source==='profile'){lang=s;put(LK,s)}
    else lang=savedLang()||s||tgLang();
    d.documentElement.lang=lang;sync();
    return lang;
  }
  // Промис всегда завершается (и при ошибке, и по таймауту): экран, который
  // после смены языка перезагружается, ждёт записи в анкету, иначе свежая
  // загрузка успеет прочитать старый язык.
  var saving=Promise.resolve();
  function persist(v){
    saving=new Promise(function(done){
      var timer=setTimeout(done,2500);
      try{
        var t=new URLSearchParams(location.search).get('t')||'';
        fetch('/api/ui-language',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({initData:(tg&&tg.initData)||'',t:t,lang:v})})
          .catch(function(){}).then(function(){clearTimeout(timer);done()});
      }catch(e){clearTimeout(timer);done()}
    });
    return saving;
  }
  function setLang(v){
    lang=v==='ru'?'ru':'en';put(LK,lang);d.documentElement.lang=lang;persist(lang);sync();
    return lang;
  }

  // Базовый вид переключателя — через :where(), чтобы у страниц со своим
  // оформлением (лига, матчи) побеждали их собственные правила.
  function injectCss(){
    if(d.getElementById('ptfPrefsCss'))return;
    var s=d.createElement('style');s.id='ptfPrefsCss';
    s.textContent=':where(.thsw){display:flex;gap:3px;padding:3px;border:1px solid var(--line,var(--border,#2A2521));'
      +'border-radius:999px;background:var(--card,var(--surf,#111010));flex:0 0 auto}'
      +':where(.thsw) :where(button){width:27px;height:24px;border:0;border-radius:999px;background:transparent;'
      +'color:var(--muted,var(--mute,#8A7F6F));font-size:13px;line-height:1;cursor:pointer;padding:0;display:flex;'
      +'align-items:center;justify-content:center;font-family:inherit;margin:0;min-height:0;min-width:0}'
      +':where(.thsw) :where(button.on){background:var(--accBg,rgba(232,164,92,.12));color:var(--accent,var(--amber,#E8A45C));'
      +'box-shadow:0 0 0 1px var(--accLine,rgba(232,164,92,.34)) inset}'
      +'.thsw button.lg{width:auto;padding:0 8px;font-size:11px;font-weight:800;letter-spacing:.04em;'
      +'margin-left:3px;box-shadow:-1px 0 0 0 var(--line,var(--border,#2A2521))}';
    (d.head||d.documentElement).appendChild(s);
  }

  function draw(m){
    var h='<button type="button" data-th="dark" title="Dark">☾</button>'
      +'<button type="button" data-th="light" title="Light">☀</button>';
    if(m.lang)h+='<button type="button" class="lg" data-lg="1"></button>';
    m.el.innerHTML=h;
    [].forEach.call(m.el.querySelectorAll('button[data-th]'),function(b){
      b.onclick=function(){setTheme(b.getAttribute('data-th'))};
    });
    var lg=m.el.querySelector('button[data-lg]');
    if(lg)lg.onclick=function(){
      var next=setLang(lang==='ru'?'en':'ru');
      if(typeof m.onLang==='function')m.onLang(next,saving);
    };
  }
  function sync(){
    mounts.forEach(function(m){
      if(!m.el||!m.el.isConnected)return;
      [].forEach.call(m.el.querySelectorAll('button[data-th]'),function(b){
        b.classList.toggle('on',b.getAttribute('data-th')===theme);
      });
      var lg=m.el.querySelector('button[data-lg]');
      // На кнопке — язык, на который переключимся, как в Fantasy.
      if(lg){lg.textContent=lang==='ru'?'EN':'RU';lg.title=lang==='ru'?'Switch to English':'Переключить на русский'}
    });
  }
  // el — контейнер .thsw; opts.lang — показывать ли RU/EN; opts.onLang(lang,
  // saved) — что сделать на экране после смены языка; saved — промис записи
  // в анкету (его ждут экраны, которые перезагружаются).
  function mount(el,opts){
    if(!el)return;
    opts=opts||{};
    injectCss();
    if(!el.classList.contains('thsw'))el.classList.add('thsw');
    var m={el:el,lang:opts.lang!==false,onLang:opts.onLang};
    mounts=mounts.filter(function(x){return x.el!==el});
    mounts.push(m);draw(m);sync();
  }

  w.PTFPrefs={
    theme:function(){return theme},setTheme:setTheme,
    lang:function(){return lang},setLang:setLang,resolveLang:resolveLang,
    saved:function(){return saving},
    mount:mount
  };
})(window,document);

// Окно с результатом действия. Любое действие в интерфейсе (запись, отмена,
// счёт, заявка) сначала отвечает здесь, на экране, и только потом — сообщением
// в боте. Закрывается только кнопкой: человек должен успеть прочитать.
//
//   PTFNotice.ok('Вы записаны', 'Счёт на 550 ฿ — в боте');
//   PTFNotice.err('Мест нет');
//   PTFNotice.say('⛔ текст') — сам решит по значку, ошибка это или нет;
//   PTFNotice.busy(btn, true) / PTFNotice.busy(btn, false) — «Секунду…» на кнопке.
(function(w,d){
  var CSS='.ptfn{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:18px;'
    +'background:rgba(0,0,0,.66);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);animation:ptfnIn .16s ease-out}'
    +'.ptfn .bx{width:100%;max-width:380px;background:#17171A;color:#EFEBE4;border:1px solid rgba(255,255,255,.1);border-radius:20px;'
    +'padding:22px 18px 16px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.5);font-family:inherit}'
    +'.ptfn .ic{font-size:42px;line-height:1;margin-bottom:10px}'
    +'.ptfn .tt{font-size:17px;font-weight:800;line-height:1.3;margin:0 0 6px}'
    +'.ptfn .tx{font-size:14px;line-height:1.5;color:#B9B1A5;white-space:pre-line;margin:0}'
    +'.ptfn .ok{margin-top:16px;width:100%;padding:12px;border:0;border-radius:13px;font-size:15px;font-weight:800;cursor:pointer;'
    +'background:linear-gradient(180deg,#8FC79A,#5FA56C);color:#0E1A10}'
    +'.ptfn .ok:focus{outline:none}'
    +'.ptfn.err .ok{background:#2A2A2E;color:#EFEBE4;border:1px solid rgba(255,255,255,.12)}'
    +'.ptfn.err .tt{color:#F08A7E}'
    +'html[data-theme="light"] .ptfn .bx{background:#FFFFFF;color:#16211A;border-color:#DDE5DB}'
    +'html[data-theme="light"] .ptfn .tx{color:#4C5A50}'
    +'html[data-theme="light"] .ptfn.err .ok{background:#EBF0EA;color:#16211A;border-color:#DDE5DB}'
    +'html[data-theme="light"] .ptfn.err .tt{color:#B23B2E}'
    +'@keyframes ptfnIn{from{opacity:0}to{opacity:1}}';
  var ready=false;
  function css(){if(ready)return;ready=true;var s=d.createElement('style');s.textContent=CSS;d.head.appendChild(s)}
  function ru(){try{return (w.PTFPrefs&&w.PTFPrefs.lang())==='ru'}catch(e){return false}}
  function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  // Убираем значок в начале — он и так будет крупно сверху.
  function strip(t){return String(t==null?'':t).replace(/^\s*(⛔|⚠️|✅|❌)\s*/,'')}
  function haptic(kind){try{var tg=w.Telegram&&w.Telegram.WebApp;tg&&tg.HapticFeedback&&tg.HapticFeedback.notificationOccurred(kind==='err'?'error':'success')}catch(e){}}
  function show(o){
    o=o||{};css();
    var old=d.getElementById('ptfNotice');if(old)old.remove();
    var kind=o.kind==='err'?'err':(o.kind==='info'?'info':'ok');
    var icon=o.icon||(kind==='err'?'⚠️':(kind==='info'?'ℹ️':'✅'));
    var title=o.title!=null?strip(o.title):(kind==='err'?(ru()?'Не получилось':'Something went wrong'):(ru()?'Готово':'Done'));
    var el=d.createElement('div');el.className='ptfn '+kind;el.id='ptfNotice';
    el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');
    el.innerHTML='<div class="bx"><div class="ic">'+esc(icon)+'</div><div class="tt">'+esc(title)+'</div>'
      +(o.text?'<p class="tx">'+esc(strip(o.text))+'</p>':'')
      +'<button type="button" class="ok">'+esc(o.button||(ru()?'Понятно':'OK'))+'</button></div>';
    el.querySelector('.ok').onclick=function(){el.remove();if(typeof o.onClose==='function')o.onClose()};
    d.body.appendChild(el);haptic(kind);
    try{el.querySelector('.ok').focus()}catch(e){}
    return el;
  }
  function busy(btn,on,label){
    if(!btn)return;
    if(on){if(btn.dataset.ptfOld==null)btn.dataset.ptfOld=btn.innerHTML;btn.disabled=true;btn.innerHTML=esc(label||(ru()?'Секунду…':'One moment…'))}
    else{btn.disabled=false;if(btn.dataset.ptfOld!=null){btn.innerHTML=btn.dataset.ptfOld;delete btn.dataset.ptfOld}}
  }
  w.PTFNotice={
    show:show,busy:busy,
    ok:function(title,text,o){return show(Object.assign({kind:'ok',title:title,text:text},o||{}))},
    // Короткая причина — заголовком; длинная — под общим «Не получилось».
    err:function(text,title,o){
      var t=strip(text);
      if(title==null&&t.length>48)return show(Object.assign({kind:'err',text:t},o||{}));
      return show(Object.assign({kind:'err',title:title==null?t:title,text:title==null?null:t},o||{}));
    },
    info:function(title,text,o){return show(Object.assign({kind:'info',title:title,text:text},o||{}))},
    // Текст с ⛔/⚠️ в начале — ошибка; иначе успех. Первая строка — заголовок.
    say:function(t,o){
      var s=String(t==null?'':t),bad=/^\s*(⛔|⚠️|❌)/.test(s);
      var lines=strip(s).split('\n'),head=lines.shift();
      if(head.length>48)return show(Object.assign({kind:bad?'err':'ok',text:strip(s)},o||{}));
      return show(Object.assign({kind:bad?'err':'ok',title:head,text:lines.join('\n').trim()},o||{}));
    }
  };
})(window,document);
