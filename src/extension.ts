import * as vscode from 'vscode'
import cet4 from './assets/CET4_T.json'
import { range } from 'lodash'
import { compareWord, getConfig, dicts, DictPickItem, getDictFile } from './utils'
import { soundPlayer } from './sound'
import { voicePlayer, getVoiceType } from './voice'

export function activate(context: vscode.ExtensionContext) {
  const globalState = context.globalState
  globalState.setKeysForSync(['chapter', 'order', 'dictKey'])
  let chapterLength = getConfig('chapterLength')
  let readOnlyMode = globalState.get('readOnlyMode', false)
  let readOnlyInterval = getConfig('readOnlyInterval')
  let readOnlyIntervalId : NodeJS.Timeout | null = null 
  let prevOrder = globalState.get('order', 0)
  if (prevOrder > chapterLength) { prevOrder = 0 }
  let isStart = false,
    hasWrong = false,
    chapter = globalState.get('chapter', 0),
    order = prevOrder,
    dict = cet4,
    dictKey = 'cet4',
    voiceType = getVoiceType(),
    voiceLock = false;
  let wordList = dict.slice(chapter * chapterLength, (chapter + 1) * chapterLength)
  let totalChapters = Math.ceil(dict.length / chapterLength)
  const wordBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100)
  const inputBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -101)
  const transBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -102)
  changeDict(globalState.get('dictKey', 'cet4'))

  function setupWord() {
    if (order === wordList.length) {
      if (!getConfig('reWrite')) {
        if (chapter === totalChapters - 1) {
          chapter = 0
        } else {
          chapter += 1
        }
        wordList = dict.slice(chapter * chapterLength, (chapter + 1) * chapterLength)
      }
      // 在罚抄模式下所有的错词都没有了 重新拼写当前章节
      else if (wordList.length === 0) {
        wordList = dict.slice(chapter * chapterLength, (chapter + 1) * chapterLength)
      }
      order = 0
    }
    let phonetic = ''
    switch (getConfig('phonetic')) {
      case 'us':
        phonetic = wordList[order].usphone || ''
        break
      case 'uk':
        phonetic = wordList[order].ukphone || ''
        break
      case 'close':
        phonetic = ''
        break
    }

    // API 字典会出现括号，但部分 vscode 插件会拦截括号的输入
    wordList[order].name = wordList[order].name.replace('(', '').replace(')', '')
    wordBar.text = `${dicts[dictKey].name} chp.${chapter + 1}  ${order + 1}/${wordList.length}  ${wordList[order].name}`
    inputBar.text = ''
    transBar.text = phonetic ? `/${phonetic}/  ` : ''
    transBar.text += wordList[order].trans.join('; ')
    if (voiceType && !voiceLock) {
      voiceLock = true
      voicePlayer(wordList[order].name, voiceType, () => {
        voiceLock = false
      });
    }
    updateGlobalState()
  }

  function refreshWordList() {
    totalChapters = Math.ceil(dict.length / chapterLength)
    wordList = dict.slice(chapter * chapterLength, (chapter + 1) * chapterLength)
    setupWord()
  }

  function changeDict(key: string) {
    if (key === 'cet4') {
      dict = cet4
    } else {
      dict = getDictFile(dicts[key].url)
    }
    dictKey = key
    refreshWordList()
  }

  function updateGlobalState() {
    globalState.update('chapter', chapter)
    globalState.update('order', order)
    globalState.update('dictKey', dictKey)
  }

  vscode.workspace.onDidChangeConfiguration(function(event) {
    const configList = ['qwerty-learner.chapterLength'];
    const affected = configList.some(item => event.affectsConfiguration(item));
    if (affected) {
      chapter = 0
      order = 0
      chapterLength = getConfig('chapterLength')
      refreshWordList()
    }
  });

  vscode.workspace.onDidChangeTextDocument((e) => {
    if (isStart && !readOnlyMode) {
      const { uri } = e.document
      // 避免破坏配置文件
      if (uri.scheme.indexOf("vscode") !== -1) { return }

      const { range, text, rangeLength } = e.contentChanges[0]

      if (text !== '' && text.length === 1) {
        // 删除用户输入的字符
        const newRange = new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character + 1)
        const editAction = new vscode.WorkspaceEdit()
        editAction.delete(uri, newRange)
        vscode.workspace.applyEdit(editAction)
        if (!hasWrong) {
          soundPlayer('click')
          inputBar.text += text
          const result = compareWord(wordList[order].name, inputBar.text)
          if (result === -2) {
            // 在拼写正确的时候 开启罚抄模式 将正确的移除 剩下的就是拼写错误的 
            if (getConfig('reWrite')) {
              wordList.splice(order, 1)
            }
            else {
              order++
            }
            soundPlayer('success')
            // 可能单词太短，播放发音回调还没执行，就输完切下一个词了，这里在切换下一个词前解发音锁
            voiceLock = false
            setupWord()
          } else if (result >= 0) {
            // 开启罚抄模式 将拼写错误的单词添加到末尾
            if (getConfig('reWrite')) {
              var lastWord = wordList[wordList.length - 1]
              var curWord = wordList[order]
              if (lastWord.name !== curWord.name || wordList.length === 1)
              {
                wordList.push(curWord)
              }
            }

            hasWrong = true
            inputBar.color = getConfig('highlightWrongColor')
            soundPlayer('wrong')
            setTimeout(() => {
              hasWrong = false
              inputBar.color = undefined
              setupWord()
            }, getConfig('highlightWrongDelay'))
          }
        }
      }
    }
  })

  let startFunction = () => {
    // 在第一次启动时，设置 qwerty-learner.readOnlyMode 的正确值
    vscode.commands.executeCommand('setContext', 'qwerty-learner.readOnlyMode', readOnlyMode);

    isStart = !isStart
    if (isStart) {
      wordBar.show()
      inputBar.show()
      transBar.show()
      setupWord()
      if(readOnlyMode){
        readOnlyIntervalId = setInterval(() => {
            order++
            setupWord()
        }, readOnlyInterval);
      }
    } else {
      wordBar.hide()
      inputBar.hide()
      transBar.hide()
      if(readOnlyMode){
        removeInterval()
      }
    }
  }

  function removeInterval() {
    if(readOnlyIntervalId !== null ){
        clearInterval(readOnlyIntervalId)
        readOnlyIntervalId=null
    }
  }

  let startCom = vscode.commands.registerCommand('qwerty-learner.Start', startFunction)

  let changeChapterCom = vscode.commands.registerCommand('qwerty-learner.changeChapter', async () => {
    const inputChapter = await vscode.window.showQuickPick(
      range(1, totalChapters + 1).map((i) => i.toString()),
      { placeHolder: `当前章节: ${chapter + 1}   共 ${totalChapters}章节` },
    )
    if (inputChapter !== undefined) {
      chapter = parseInt(inputChapter) - 1
      order = 0
      refreshWordList()
    }
  })

  let changeDictCom = vscode.commands.registerCommand('qwerty-learner.changeDict', async () => {
    const dictList: DictPickItem[] = []
    Object.keys(dicts).forEach((key) => {
      dictList.push({ label: dicts[key].name, path: dicts[key].url, detail: dicts[key].description, key: key })
    })
    const inputDict = await vscode.window.showQuickPick(dictList, { placeHolder: `当前字典: ${dicts[dictKey].name}` })
    if (inputDict !== undefined) {
      chapter = 0
      order = 0
      changeDict(inputDict.key)
    }
  })

  let closeReadOnlyMode = vscode.commands.registerCommand('qwerty-learner.closeReadOnlyMode', () => {
    readOnlyMode = false
    globalState.update('readOnlyMode', false)
    vscode.commands.executeCommand('setContext', 'qwerty-learner.readOnlyMode', false);
    removeInterval()
  })

  let openReadOnlyMode = vscode.commands.registerCommand('qwerty-learner.openReadOnlyMode', () => {
    readOnlyMode = true
    globalState.update('readOnlyMode', true)
    vscode.commands.executeCommand('setContext', 'qwerty-learner.readOnlyMode', true);
    isStart = false
    startFunction()
    
  })

  context.subscriptions.push(startCom)
  context.subscriptions.push(changeChapterCom)
  context.subscriptions.push(changeDictCom)
  context.subscriptions.push(closeReadOnlyMode)
  context.subscriptions.push(openReadOnlyMode)
}

// this method is called when your extension is deactivated
export function deactivate() {
  console.log('我裂开了')
}
