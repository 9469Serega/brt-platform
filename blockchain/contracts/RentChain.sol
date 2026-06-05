// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IBRT {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title RentChain
 * @notice Peer-to-peer rental marketplace.
 *         Lenders list items; borrowers rent them with BRT tokens.
 *         Platform takes a 2% commission on every rental fee.
 *
 * Flow:
 *  1. Lender calls listItem(name, pricePerDay, depositAmount)
 *  2. Borrower calls rentItem(itemId, days) — pays deposit + fee upfront
 *  3. After rental, lender calls returnItem(itemId) to release deposit to borrower
 *     and transfer rental fee (minus 2%) to lender.
 */
contract RentChain {
    IBRT public brtToken;
    address public platform;
    uint256 public commissionBps = 200; // 2%

    struct Item {
        uint256 id;
        address lender;
        string  name;
        uint256 pricePerDay;   // BRT (wei)
        uint256 depositAmount; // BRT (wei)
        bool    available;
    }

    struct Rental {
        uint256 id;
        uint256 itemId;
        address borrower;
        uint256 startTs;
        uint256 endTs;
        uint256 totalFee;
        uint256 deposit;
        bool    active;
        bool    returned;
    }

    uint256 public nextItemId   = 1;
    uint256 public nextRentalId = 1;

    mapping(uint256 => Item)   public items;
    mapping(uint256 => Rental) public rentals;
    mapping(address => uint256[]) public lenderItems;
    mapping(address => uint256[]) public borrowerRentals;

    event ItemListed  (uint256 indexed itemId, address indexed lender, string name, uint256 pricePerDay);
    event ItemRented  (uint256 indexed rentalId, uint256 indexed itemId, address indexed borrower, uint256 days);
    event ItemReturned(uint256 indexed rentalId, uint256 indexed itemId);
    event ItemUnlisted(uint256 indexed itemId);

    constructor(address _brtToken) {
        brtToken = IBRT(_brtToken);
        platform = msg.sender;
    }

    // ── LIST ──

    function listItem(
        string calldata name,
        uint256 pricePerDay,
        uint256 depositAmount
    ) external returns (uint256) {
        require(bytes(name).length > 0, "RC: name empty");
        require(pricePerDay > 0,        "RC: price zero");

        uint256 id = nextItemId++;
        items[id] = Item({
            id:            id,
            lender:        msg.sender,
            name:          name,
            pricePerDay:   pricePerDay,
            depositAmount: depositAmount,
            available:     true
        });
        lenderItems[msg.sender].push(id);
        emit ItemListed(id, msg.sender, name, pricePerDay);
        return id;
    }

    function unlistItem(uint256 itemId) external {
        Item storage item = items[itemId];
        require(item.lender == msg.sender, "RC: not lender");
        require(item.available,            "RC: not available");
        item.available = false;
        emit ItemUnlisted(itemId);
    }

    // ── RENT ──

    function rentItem(uint256 itemId, uint256 days_) external returns (uint256) {
        require(days_ > 0,  "RC: days zero");
        Item storage item = items[itemId];
        require(item.available, "RC: not available");
        require(item.lender != msg.sender, "RC: own item");

        uint256 totalFee = item.pricePerDay * days_;
        uint256 commission = (totalFee * commissionBps) / 10_000;
        uint256 deposit = item.depositAmount;
        uint256 total = totalFee + deposit;

        // Pull BRT from borrower
        require(brtToken.transferFrom(msg.sender, address(this), total), "RC: transfer failed");

        // Pay commission to platform
        if (commission > 0) {
            brtToken.transfer(platform, commission);
        }

        item.available = false;

        uint256 rentalId = nextRentalId++;
        rentals[rentalId] = Rental({
            id:       rentalId,
            itemId:   itemId,
            borrower: msg.sender,
            startTs:  block.timestamp,
            endTs:    block.timestamp + days_ * 1 days,
            totalFee: totalFee - commission,
            deposit:  deposit,
            active:   true,
            returned: false
        });
        borrowerRentals[msg.sender].push(rentalId);
        emit ItemRented(rentalId, itemId, msg.sender, days_);
        return rentalId;
    }

    // ── RETURN ──

    function returnItem(uint256 rentalId) external {
        Rental storage rental = rentals[rentalId];
        Item   storage item   = items[rental.itemId];

        require(rental.active,                        "RC: not active");
        require(!rental.returned,                     "RC: already returned");
        require(msg.sender == item.lender || msg.sender == rental.borrower, "RC: unauthorized");

        rental.returned = true;
        rental.active   = false;
        item.available  = true;

        // Release fee to lender
        if (rental.totalFee > 0) {
            brtToken.transfer(item.lender, rental.totalFee);
        }
        // Return deposit to borrower
        if (rental.deposit > 0) {
            brtToken.transfer(rental.borrower, rental.deposit);
        }
        emit ItemReturned(rentalId, rental.itemId);
    }

    // ── VIEWS ──

    function getItem(uint256 itemId) external view returns (Item memory) {
        return items[itemId];
    }

    function getRental(uint256 rentalId) external view returns (Rental memory) {
        return rentals[rentalId];
    }

    function getLenderItems(address lender) external view returns (uint256[] memory) {
        return lenderItems[lender];
    }

    function getBorrowerRentals(address borrower) external view returns (uint256[] memory) {
        return borrowerRentals[borrower];
    }

    function setCommission(uint256 bps) external {
        require(msg.sender == platform, "RC: not platform");
        require(bps <= 1000, "RC: max 10%");
        commissionBps = bps;
    }
}
