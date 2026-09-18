// Loads chat avatars lazily, a few at a time, after the chat list has
// already rendered — so opening the page never blocks on fetching every
// contact's profile picture from WhatsApp up front.

(function () {
    var CONCURRENCY = 3;

    var nodes = Array.prototype.slice.call(document.querySelectorAll('.avatar-default[data-avatar-id]'));
    var index = 0;

    function loadNext() {
        if (index >= nodes.length) return;
        var node = nodes[index++];
        var id = node.getAttribute('data-avatar-id');

        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/avatar/' + id, true);
        xhr.onreadystatechange = function () {
            if (xhr.readyState === 4) {
                if (xhr.status === 200) {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        if (data && data.url) {
                            var img = document.createElement('img');
                            img.className = 'avatar';
                            img.src = data.url;
                            node.parentNode.replaceChild(img, node);
                        }
                    } catch (e) { /* keep default letter avatar */ }
                }
                loadNext();
            }
        };
        xhr.send(null);
    }

    for (var i = 0; i < CONCURRENCY; i++) {
        loadNext();
    }
})();
