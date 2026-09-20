var pollTimer = null;
var idleTimer = null;
var pollChatId = null;
var pollSince = 0;

var POLL_INTERVAL = 5000;
var IDLE_AFTER = 180000; // 3 minutes

function startPolling(chatId, sinceTs) {
    pollChatId = chatId;
    pollSince = sinceTs || 0;

    setStatusLive();
    resetIdleTimer();

    if (pollTimer) {
        clearInterval(pollTimer);
    }
    pollTimer = setInterval(pollOnce, POLL_INTERVAL);
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    setStatusIdle();
}

function resetIdleTimer() {
    if (idleTimer) {
        clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(stopPolling, IDLE_AFTER);
}

function setStatusIdle() {
    var box = document.getElementById('statusBox');
    if (box) {
        box.className = 'status idle';
        box.innerHTML = 'IDLE';
    }
}

function setStatusLive() {
    var box = document.getElementById('statusBox');
    if (box) {
        box.className = 'status live';
        box.innerHTML = 'LIVE';
    }
}

function probeNow() {
    startPolling(pollChatId, pollSince);
    pollOnce();
}

function pollOnce() {
    if (!pollChatId) {
        return;
    }

    var xhr = new XMLHttpRequest();
    var url = '/chat/' + pollChatId + '/poll?since=' + pollSince;

    xhr.open('GET', url, true);
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4 && xhr.status === 200) {
            if (xhr.responseText && xhr.responseText.length > 0) {
                var container = document.getElementById('messages');
                if (container) {
                    var wasAtBottom = isScrolledToBottom();
                    container.innerHTML = container.innerHTML + xhr.responseText;
                    if (wasAtBottom) {
                        scrollToBottom();
                    }
                }
                pollSince = Math.floor(Date.now() / 1000);
                resetIdleTimer();
                setStatusLive();
            }
        }
    };
    xhr.send(null);
}

function isScrolledToBottom() {
    var container = document.getElementById('messages');
    if (!container) return true;
    return (container.scrollHeight - container.scrollTop - container.clientHeight) < 60;
}

function scrollToBottom() {
    var container = document.getElementById('messages');
    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

function sendMessage(e) {
    e.preventDefault();
    var input = document.getElementById('textInput');
    var text = input.value.trim();
    if (!text) return;

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/chat/' + pollChatId + '/send', true);
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
            input.value = '';
            if (xhr.status === 200) {
                var container = document.getElementById('messages');
                if (container) {
                    container.innerHTML = container.innerHTML + xhr.responseText;
                    scrollToBottom();
                }
                pollSince = Math.floor(Date.now() / 1000);
                resetIdleTimer();
                setStatusLive();
            } else {
                alert('Failed to send message.');
            }
        }
    };
    xhr.send('text=' + encodeURIComponent(text));
}

function loadOlder() {
    if (!pollChatId) return;
    var before = typeof OLDEST_TS !== 'undefined' ? OLDEST_TS : Math.floor(Date.now() / 1000);

    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/chat/' + pollChatId + '/older?before=' + before, true);
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4 && xhr.status === 200) {
            var container = document.getElementById('messages');
            if (container && xhr.responseText) {
                var prevHeight = container.scrollHeight;

                // Avoid insertAdjacentHTML - not reliably supported on older
                // WebKit (e.g. BlackBerry 6). Build the nodes in a scratch
                // element instead and move them with plain DOM calls, which
                // have been supported forever.
                var temp = document.createElement('div');
                temp.innerHTML = xhr.responseText;
                var frag = document.createDocumentFragment();
                while (temp.firstChild) {
                    frag.appendChild(temp.firstChild);
                }
                container.insertBefore(frag, container.firstChild);

                container.scrollTop = container.scrollHeight - prevHeight;

                var firstMsg = container.getElementsByClassName ? container.getElementsByClassName('msg')[0] : null;
                if (firstMsg) {
                    OLDEST_TS = Number(firstMsg.getAttribute('data-ts')) || OLDEST_TS;
                }
            }
        }
    };
    xhr.send(null);
}

function loadWho() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/chat/' + pollChatId + '/who', true);
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4 && xhr.status === 200) {
            var box = document.getElementById('whoBox');
            if (box) {
                box.innerHTML = xhr.responseText;
            }
        }
    };
    xhr.send(null);
}
