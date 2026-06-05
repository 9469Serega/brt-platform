// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BRT Token
 * @notice Native utility token of the RentChain platform.
 *         Used to pay rental fees and 2% commission on every rental.
 * @dev Standard ERC-20 with minting (owner-only) and burn.
 *      Deployed on RentChain network (Chain ID 1337).
 *      Contract: 0x5FbDB2315678afecb367f032d93F642f64180aa3
 */
contract BRTToken {
    string  public constant name     = "BRT Token";
    string  public constant symbol   = "BRT";
    uint8   public constant decimals = 18;

    uint256 public totalSupply;
    address public owner;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    // Events (ERC-20 standard)
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Mint(address indexed to, uint256 amount);
    event Burn(address indexed from, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "BRT: not owner");
        _;
    }

    constructor(uint256 initialSupply) {
        owner = msg.sender;
        _mint(msg.sender, initialSupply);
    }

    // ── ERC-20 ──

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function allowance(address _owner, address spender) public view returns (uint256) {
        return _allowances[_owner][spender];
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        require(allowed >= amount, "BRT: insufficient allowance");
        _allowances[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    // ── MINT / BURN ──

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
        emit Mint(to, amount);
    }

    function burn(uint256 amount) external {
        require(_balances[msg.sender] >= amount, "BRT: burn exceeds balance");
        _balances[msg.sender] -= amount;
        totalSupply -= amount;
        emit Burn(msg.sender, amount);
    }

    // ── INTERNAL ──

    function _transfer(address from, address to, uint256 amount) internal {
        require(from != address(0), "BRT: from zero address");
        require(to   != address(0), "BRT: to zero address");
        require(_balances[from] >= amount, "BRT: insufficient balance");
        _balances[from] -= amount;
        _balances[to]   += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        require(to != address(0), "BRT: mint to zero");
        totalSupply       += amount;
        _balances[to]     += amount;
        emit Transfer(address(0), to, amount);
    }
}
