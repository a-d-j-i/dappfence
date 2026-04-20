(async () => {
    while (true) {
        console.log('NULL', new Date().toISOString());
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
})();
